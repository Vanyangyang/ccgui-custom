import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CLI_CONFIG_CHANGED_EVENT, PSEUDO_LOCAL } from "@/features/settings/providers";
import { publishedCursorCatalog } from "@/components/application/ai-chat/cursor-models";
import { readHandoffModelCatalog } from "./handoff-model-catalog";

const mocks = vi.hoisted(() => ({ listEngines: vi.fn(), getCliConfig: vi.fn(), getAppSettings: vi.fn(), listEngineModels: vi.fn(), cursorModelCatalog: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const selection = { engine: "claude" as const, model: "unavailable-saved", providerId: "relay", effort: "high" };
const originalLanguage = i18n.language;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function read(value = selection) {
  let result!: Awaited<ReturnType<typeof readHandoffModelCatalog>>;
  await act(async () => { void readHandoffModelCatalog(value).then(value => { result = value; }); });
  return result;
}

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  mocks.listEngines.mockResolvedValue(["claude", "codex", "pi", "cursor", "omp"].map(id => ({ id, available: true, enabled: true })));
  mocks.getCliConfig.mockResolvedValue({ claude: { current: PSEUDO_LOCAL, providers: { relay: {
    name: "Custom relay", model: "vendor/opus:5.5+custom", apiKey: "SECRET_KEY", baseUrl: "https://secret.invalid",
  } } } });
  mocks.getAppSettings.mockResolvedValue({ customModels: { claude: ["private/custom"] }, customModelLabels: { claude: { "private/custom": "My custom" } }, token: "SECRET_SETTINGS" });
  mocks.listEngineModels.mockImplementation(async (engine: string) => ({ authoritative: true, models: [{ id: `${engine}-model`, name: `${engine} label`, description: "SECRET_DESCRIPTION" }] }));
});
afterEach(async () => { vi.useRealTimers(); await i18n.changeLanguage(originalLanguage); });

describe("read-only handoff model catalog", () => {
  it("uses picker channel/custom models and safe fields without showing UI or mutating global Cursor state", async () => {
    const html = document.body.innerHTML;
    const storage = { ...localStorage };
    const cursor = publishedCursorCatalog();
    const result = await read();
    expect(result.engines.map(engine => engine.id)).toEqual(["claude", "codex", "pi", "cursor"]);
    const claude = result.engines[0];
    expect(claude.models).toEqual([
      { id: "vendor/opus:5.5+custom", label: "vendor/opus:5.5+custom" },
      { id: "claude-model", label: "claude label" }, { id: "private/custom", label: "My custom" },
    ]);
    expect(claude.providers).toContainEqual({ id: "relay", label: "Custom relay" });
    expect(claude.defaultSelection).toEqual({ engine: "claude", model: "vendor/opus:5.5+custom", providerId: "relay", effort: "medium" });
    expect(claude.efforts.map(effort => effort.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(result.engines[3].defaultSelection).toEqual({ engine: "cursor", model: "cursor-model", providerId: PSEUDO_LOCAL });
    expect(result.engines[3].efforts).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|secret.invalid|apiKey|baseUrl|description/);
    expect(document.body.innerHTML).toBe(html);
    expect({ ...localStorage }).toEqual(storage);
    expect(publishedCursorCatalog()).toEqual(cursor);
    expect(mocks.cursorModelCatalog).not.toHaveBeenCalled();
    expect(mocks.listEngineModels.mock.calls.every(call => call[1] === undefined)).toBe(true);
    result.selection.model = "changed";
    expect(selection.model).toBe("unavailable-saved");
    const reads = mocks.listEngines.mock.calls.length;
    window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT));
    expect(mocks.listEngines).toHaveBeenCalledTimes(reads);
  });

  it("recomputes local-channel models for the requested provider without appending stale selection", async () => {
    const result = await read({ ...selection, providerId: PSEUDO_LOCAL });
    expect(result.engines[0].models.map(model => model.id)).toEqual(["claude-model", "private/custom"]);
  });

  it("keeps healthy engines selectable when a saved provider is missing and defaults to local configuration", async () => {
    const result = await read({ ...selection, providerId: "removed-provider" });
    expect(result.selection.providerId).toBe("removed-provider");
    expect(result.engines[0].available).toBe(true);
    expect(result.engines[0].models.map(model => model.id)).toEqual(["claude-model", "private/custom"]);
    expect(result.engines[0].defaultSelection).toEqual({ engine: "claude", model: "claude-model", providerId: PSEUDO_LOCAL, effort: "medium" });
    expect(result.engines[0].providers).toContainEqual({ id: "relay", label: "Custom relay" });
  });

  it("waits for discovery, custom settings, and every engine probe", async () => {
    const discovery = deferred<unknown>(); const settings = deferred<unknown>(); const probe = deferred<unknown>();
    mocks.listEngines.mockReturnValueOnce(discovery.promise);
    mocks.getAppSettings.mockReturnValueOnce(settings.promise);
    mocks.listEngineModels.mockReturnValueOnce(probe.promise);
    let result: unknown;
    await act(async () => { void readHandoffModelCatalog(selection).then(value => { result = value; }); });
    expect(result).toBeUndefined();
    await act(async () => discovery.resolve([{ id: "claude", available: true, enabled: true }]));
    expect(result).toBeUndefined();
    await act(async () => probe.resolve({ authoritative: true, models: [{ id: "found" }] }));
    expect(result).toBeUndefined();
    await act(async () => settings.resolve({ customModels: { claude: ["late-custom"] } }));
    expect(JSON.stringify(result)).toContain("late-custom");
  });

  it.each(["listEngines", "getCliConfig", "getAppSettings"] as const)("rejects %s failure explicitly and cleans subscriptions", async method => {
    mocks[method].mockRejectedValue(new Error("SECRET_ERROR"));
    let error: unknown;
    await act(async () => { void readHandoffModelCatalog(selection).catch(value => { error = value; }); });
    expect(error).toEqual(new Error("HANDOFF_MODEL_CATALOG_DISCOVERY_FAILED"));
    const reads = mocks.getCliConfig.mock.calls.length;
    window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT));
    expect(mocks.getCliConfig).toHaveBeenCalledTimes(reads);
  });

  it("marks a failed engine unavailable while retaining healthy engines", async () => {
    mocks.listEngineModels.mockImplementation(async (engine: string) => {
      if (engine === "claude") throw new Error("offline");
      return { models: [{ id: `${engine}-model` }] };
    });
    const result = await read();
    expect(result.engines[0].available).toBe(false);
    expect(result.engines[0].models).toEqual([]);
    expect(result.engines[1].available).toBe(true);
  });

  it.each(["listEngines", "getAppSettings", "listEngineModels"] as const)("times out unresolved %s and ignores late responses after removing subscriptions", async method => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    mocks[method].mockReturnValue(pending.promise);
    let error: unknown;
    await act(async () => { void readHandoffModelCatalog(selection).catch(value => { error = value; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(error).toEqual(new Error("HANDOFF_MODEL_CATALOG_TIMEOUT"));
    expect(vi.getTimerCount()).toBe(0);
    const reads = mocks.getAppSettings.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT));
      pending.resolve({ customModels: { claude: ["late"] } });
    });
    expect(mocks.getAppSettings).toHaveBeenCalledTimes(reads);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
