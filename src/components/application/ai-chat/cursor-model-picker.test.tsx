import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { refreshAppSettings, updateCursorModelSelection, listeners } = vi.hoisted(() => ({
  refreshAppSettings: vi.fn(), updateCursorModelSelection: vi.fn(), listeners: new Set<() => void>(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { refreshAppSettings, updateCursorModelSelection } }));
vi.mock("@/lib/events", () => ({ listenSettingsChanged: async (callback: () => void) => {
  listeners.add(callback); return () => listeners.delete(callback);
} }));
import i18n from "@/lib/i18n";
import { CursorModelList } from "./cursor-model-picker";
import { cursorLaunchModel, publishCursorCatalog, readCursorPins, writeCursorModelParams, writeCursorPins, type CursorModel } from "./cursor-models";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const models: CursorModel[] = [{ id: "grok-4.7", name: "Grok 4.7", parameters: [
  { id: "fast", name: "Fast", current: "true", options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] },
  { id: "context", name: "Context", current: "256k", options: [{ value: "256k", name: "256K" }, { value: "500k", name: "500K" }] },
  { id: "reasoning_effort", name: "Effort", current: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
] }];
let host: HTMLDivElement;
let root: Root;
let allowed: string[];
const onPick = vi.fn();
const mount = () => act(async () => { root.render(<CursorModelList models={models} selectedModelId="grok-4.7" query="" onPick={onPick} />); });
const clickText = async (text: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
};
beforeEach(() => {
  localStorage.clear(); publishCursorCatalog(models);
  allowed = [];
  onPick.mockReset();
  refreshAppSettings.mockReset().mockImplementation(async () => ({ leaderAllowedModels: { cursor: [...allowed] } }));
  updateCursorModelSelection.mockReset().mockImplementation(async (add: string[], remove: string[]) => {
    allowed = [...new Set([...allowed, ...add])].filter(id => !remove.includes(id));
    return [...allowed];
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); publishCursorCatalog([]); });

it("restores enabled models and parameter choices after remount and sends the restored values", async () => {
  await mount();
  await clickText("500K"); await clickText("Low");
  const fast = host.querySelector<HTMLInputElement>('input[aria-label="Fast"]');
  const pin = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((node) => node !== fast);
  expect(fast).not.toBeNull(); expect(pin).toBeDefined();
  await act(async () => { fast!.click(); }); await act(async () => { pin!.click(); });
  expect(updateCursorModelSelection).toHaveBeenCalledWith(["grok-4.7"], []);
  act(() => root.unmount()); root = createRoot(host); await mount();
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Fast"]')!.checked).toBe(false);
  expect([...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) => node.textContent)).toContain("500K");
  expect([...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) => node.textContent)).toContain("Low");
  expect(readCursorPins()).toEqual(["grok-4.7"]);
  expect(cursorLaunchModel("grok-4.7")).toBe('grok-4.7\u001e{"fast":"false","context":"500k","reasoning_effort":"low"}');
});

it("explains that checkmarks save model authorization without a settings detour", async () => {
  await mount();
  expect(host.textContent).toContain(i18n.t("chat.cursorSelectionNote"));
  expect(host.querySelector('a[href="#/settings?page=leader"]')).toBeNull();
});

it("keeps hidden context and the newly chosen effort when the fallback catalog changes parameter ids", async () => {
  writeCursorModelParams("grok-4.7", { context: "500k", reasoning_effort: "high", fast: "true" });
  const fallback = models.map((model) => ({ ...model, parameters: model.parameters.filter((parameter) => parameter.id !== "context")
    .map((parameter) => parameter.id === "reasoning_effort" ? { ...parameter, id: "effort" } : parameter) }));
  await act(async () => { root.render(<CursorModelList models={fallback} selectedModelId="grok-4.7" query="" onPick={() => {}} />); });
  await clickText("Low");
  act(() => root.unmount()); root = createRoot(host); await mount();
  expect([...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) => node.textContent)).toEqual(expect.arrayContaining(["500K", "Low"]));
  expect(cursorLaunchModel("grok-4.7")).toBe('grok-4.7\u001e{"fast":"true","context":"500k","reasoning_effort":"low"}');
});

function modelSwitch() {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t("chat.cursorEnableModel", { model: "Grok 4.7" })}"]`)!;
}

it("authorizes before publishing a newly selected model for immediate sending", async () => {
  await mount();
  let complete!: (value: string[]) => void;
  updateCursorModelSelection.mockImplementationOnce(() => new Promise<string[]>(resolve => { complete = resolve; }));
  await clickText("Grok 4.7");
  expect(onPick).not.toHaveBeenCalled();
  expect(modelSwitch().checked).toBe(false);
  expect(modelSwitch().disabled).toBe(true);
  await act(async () => { allowed = ["grok-4.7"]; complete([...allowed]); });
  expect(modelSwitch().checked).toBe(true);
  expect(onPick).toHaveBeenCalledWith("grok-4.7");
});

it("keeps failed saves disabled and never publishes a falsely authorized model", async () => {
  await mount();
  updateCursorModelSelection.mockRejectedValueOnce(new Error("disk full"));
  await clickText("Grok 4.7");
  expect(onPick).not.toHaveBeenCalled();
  expect(modelSwitch().checked).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  await clickText("Grok 4.7");
  expect(onPick).toHaveBeenCalledWith("grok-4.7");
  expect(modelSwitch().checked).toBe(true);
});

it("reconciles a committed warning while still reporting the failed action", async () => {
  await mount();
  updateCursorModelSelection.mockImplementationOnce(async () => { allowed = ["grok-4.7"]; throw new Error("saved with warning"); });
  await clickText("Grok 4.7");
  expect(modelSwitch().checked).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("saved with warning");
  expect(onPick).not.toHaveBeenCalled();
});

it("synchronizes existing checkmarks once and does not undo a later deselection", async () => {
  writeCursorPins(["grok-4.7", "auto", "default"]);
  allowed = ["sonnet-5.5"];
  await mount();
  expect(updateCursorModelSelection).toHaveBeenCalledWith(["grok-4.7"], []);
  expect(allowed).toEqual(["sonnet-5.5", "grok-4.7"]);
  await act(async () => { modelSwitch().click(); });
  expect(allowed).toEqual(["sonnet-5.5"]);
  act(() => root.unmount()); root = createRoot(host); await mount();
  expect(modelSwitch().checked).toBe(false);
  expect(updateCursorModelSelection).toHaveBeenCalledTimes(2);
});

it("reflects settings changes from another entry without re-authorizing removed models", async () => {
  allowed = ["grok-4.7"];
  await mount();
  expect(modelSwitch().checked).toBe(true);
  await act(async () => { allowed = []; listeners.forEach(callback => callback()); });
  expect(modelSwitch().checked).toBe(false);
  expect(updateCursorModelSelection).not.toHaveBeenCalled();
});
