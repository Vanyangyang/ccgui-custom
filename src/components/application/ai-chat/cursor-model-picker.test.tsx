import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import "@/lib/i18n";
import { CursorModelList } from "./cursor-model-picker";
import { cursorLaunchModel, publishCursorCatalog, readCursorPins, writeCursorModelParams, type CursorModel } from "./cursor-models";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const models: CursorModel[] = [{ id: "grok-4.7", name: "Grok 4.7", parameters: [
  { id: "fast", name: "Fast", current: "true", options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] },
  { id: "context", name: "Context", current: "256k", options: [{ value: "256k", name: "256K" }, { value: "500k", name: "500K" }] },
  { id: "reasoning_effort", name: "Effort", current: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
] }];
let host: HTMLDivElement;
let root: Root;
const mount = () => act(() => root.render(<CursorModelList models={models} selectedModelId="grok-4.7" query="" onPick={() => {}} />));
const clickText = (text: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text);
  expect(button).toBeDefined();
  act(() => button!.click());
};
beforeEach(() => {
  localStorage.clear(); publishCursorCatalog(models);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); publishCursorCatalog([]); });

it("restores pinned models and parameter choices after remount and sends the restored values", () => {
  mount();
  clickText("500K"); clickText("Low");
  const fast = host.querySelector<HTMLInputElement>('input[aria-label="Fast"]');
  const pin = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((node) => node !== fast);
  expect(fast).not.toBeNull(); expect(pin).toBeDefined();
  act(() => fast!.click()); act(() => pin!.click());
  act(() => root.unmount()); root = createRoot(host); mount();
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Fast"]')!.checked).toBe(false);
  expect([...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) => node.textContent)).toContain("500K");
  expect([...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) => node.textContent)).toContain("Low");
  expect(readCursorPins()).toEqual(["grok-4.7"]);
  expect(cursorLaunchModel("grok-4.7")).toBe('grok-4.7\u001e{"fast":"false","context":"500k","reasoning_effort":"low"}');
});

it("keeps hidden context and the newly chosen effort when the fallback catalog changes parameter ids", () => {
  writeCursorModelParams("grok-4.7", { context: "500k", reasoning_effort: "high", fast: "true" });
  const fallback = models.map((model) => ({ ...model, parameters: model.parameters.filter((parameter) => parameter.id !== "context")
    .map((parameter) => parameter.id === "reasoning_effort" ? { ...parameter, id: "effort" } : parameter) }));
  act(() => root.render(<CursorModelList models={fallback} selectedModelId="grok-4.7" query="" onPick={() => {}} />));
  clickText("Low");
  act(() => root.unmount()); root = createRoot(host); mount();
  expect([...host.querySelectorAll('[role="radio"][aria-checked="true"]')].map((node) => node.textContent)).toEqual(expect.arrayContaining(["500K", "Low"]));
  expect(cursorLaunchModel("grok-4.7")).toBe('grok-4.7\u001e{"fast":"true","context":"500k","reasoning_effort":"low"}');
});
