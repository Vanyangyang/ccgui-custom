import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AutoTitleModel } from "@/lib/ipc";
import type { AssistantNoticesConfig, AssistantNoticesStatus } from "./types";
import { defaultNoticeConfig, noticeConfig } from "./config";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), models: vi.fn(), providers: vi.fn() }));
vi.mock("@/lib/transport", () => ({ ...mock, isWeb: false }));
vi.mock("@/lib/ipc", () => ({ ipc: { autoTitleModels: mock.models, getCliConfig: mock.providers } }));
import { useNoticeSettings } from "./use-notice-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let current: ReturnType<typeof useNoticeSettings>;
let status: AssistantNoticesStatus;
let callbacks: Record<string, (event: { payload: unknown }) => void>;
let stops: ReturnType<typeof vi.fn>[];
let root: Root;
let container: HTMLDivElement;
const model: AutoTitleModel = { engine: "codex", id: "astra", name: "Astra", provider: "Provider A", supportsEffort: true, effortLevels: ["medium", "high"], resolvedModel: null };
function Harness() { current = useNoticeSettings(); return null; }
beforeEach(() => {
  status = { ...defaultNoticeConfig, available: true, observerAvailable: true, voiceAvailable: true, sourceEngines: ["codex", "cursor"], revision: 1, reason: "", model: "gemini-4-argon", effort: "medium", provider: "vertex" };
  callbacks = {}; stops = [];
  mock.listen.mockReset().mockImplementation(async (event: string, callback: typeof callbacks[string]) => { callbacks[event] = callback; const stop = vi.fn(); stops.push(stop); return stop; });
  mock.models.mockReset().mockResolvedValue([model]);
  mock.providers.mockReset().mockResolvedValue({ codex: { current: "a", providers: { a: { name: "Provider A" } } } });
  mock.invoke.mockReset().mockImplementation(async (command: string, args?: { config: AssistantNoticesConfig; expectedRevision: number }) => {
    if (command === "assistant_notices_status") return status;
    if (command === "assistant_notices_displays") return [];
    if (command === "assistant_notices_configure") {
      if (args!.expectedRevision !== status.revision) throw new Error("config_conflict");
      status = { ...status, ...args!.config, revision: status.revision + 1 }; return status;
    }
    throw new Error(command);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const mount = () => act(async () => root.render(<Harness />));
const event = (name: string, payload: unknown = null) => act(async () => callbacks[name]({ payload }));

it("rebases only user edits after conflict and preserves concurrent voice, display and generator changes", async () => {
  await mount();
  await act(async () => current.change({ bodyTextPercent: 180 }));
  status = { ...status, revision: 2, voiceEnabled: false, displayTarget: { mode: "fixed", id: "other", label: "Other screen" }, observerEngine: "codex", observerModel: "", observerEffort: "high" };
  await event("assistant-notices://status", status);
  expect(current.draft!.voiceEnabled).toBe(true);
  await act(async () => { await expect(current.save()).rejects.toThrow("config_conflict"); });
  expect(mock.invoke).toHaveBeenLastCalledWith("assistant_notices_configure", { config: { ...defaultNoticeConfig, bodyTextPercent: 180 }, expectedRevision: 1 });
  await act(async () => current.retry());
  expect(current.draft).toEqual({ ...noticeConfig(status), bodyTextPercent: 180 });
  await act(async () => current.save());
  expect(status).toMatchObject({ bodyTextPercent: 180, voiceEnabled: false, displayTarget: { id: "other" }, observerEngine: "codex", observerModel: "", observerEffort: "high", revision: 3 });
  expect(current.dirty).toBe(false);
  status = { ...status, revision: 4, bodyTextPercent: 120 };
  await event("assistant-notices://status", status);
  expect(current.draft!.bodyTextPercent).toBe(120);
});

it("coalesces provider events, rejects late catalog snapshots and preserves the edit buffer", async () => {
  await mount();
  await act(async () => current.change({ titleTextPercent: 150 }));
  const oldModels = Promise.withResolvers<AutoTitleModel[]>();
  mock.models.mockReturnValueOnce(oldModels.promise).mockResolvedValue([{ ...model, id: "new-model", provider: "Provider B" }]);
  mock.providers.mockResolvedValueOnce({ codex: { current: "old", providers: { old: { name: "Stale provider" } } } }).mockResolvedValue({ codex: { current: "b", providers: { b: { name: "Provider B" } } } });
  await event("engine-config://changed");
  await act(async () => { for (let i = 0; i < 20; i++) callbacks["engine-config://changed"]({ payload: null }); });
  expect(mock.models).toHaveBeenCalledTimes(2);
  expect(current.providers.codex).toBe("Provider A");
  await act(async () => oldModels.resolve([{ ...model, id: "stale-model" }]));
  expect(mock.models).toHaveBeenCalledTimes(3);
  expect(current.models.some(item => item.id === "stale-model")).toBe(false);
  expect(current.models.some(item => item.id === "new-model")).toBe(true);
  expect(current.providers.codex).toBe("Provider B");
  expect(current.draft!.titleTextPercent).toBe(150);
  await event("settings://changed");
  expect(mock.models).toHaveBeenCalledTimes(4);
  await act(async () => root.render(null));
  for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
  await event("engine-config://changed");
  expect(mock.models).toHaveBeenCalledTimes(4);
});

it("offers an empty default model only for callable engines without inventing model effort support", async () => {
  status = { ...status, observerEngine: "codex", observerModel: "", observerEffort: "high" };
  await mount();
  expect(current.models.find(item => item.engine === "codex" && item.id === "")).toMatchObject({ supportsEffort: false });
  expect(current.models.some(item => item.engine === "cursor")).toBe(false);
  expect(current.draft).toMatchObject({ observerModel: "", observerEffort: "high" });
  mock.models.mockResolvedValue([]);
  await event("engine-config://changed");
  expect(current.models.some(item => item.engine === "codex")).toBe(false);
  expect(current.draft).toMatchObject({ observerModel: "", observerEffort: "high" });
  expect(mock.invoke.mock.calls.some(([command]) => command === "assistant_notices_configure")).toBe(false);
});

it("cleans up catalog listeners registered after unmount without starting catalog reads", async () => {
  const registered = Promise.withResolvers<() => void>(); const stop = vi.fn();
  const original = mock.listen.getMockImplementation()!;
  mock.listen.mockImplementation((event: string, callback: typeof callbacks[string]) => event === "assistant-notices://status" ? original(event, callback) : registered.promise);
  await mount();
  await act(async () => root.render(null));
  await act(async () => registered.resolve(stop));
  expect(stop).toHaveBeenCalledTimes(2);
  expect(mock.models).not.toHaveBeenCalled();
});
