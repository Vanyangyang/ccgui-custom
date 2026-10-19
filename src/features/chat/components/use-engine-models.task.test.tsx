import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { EngineInfo } from "@/lib/ipc";
import { useEngineModels, type EngineModelsState } from "./use-engine-models";
import { publishedCursorCatalog, publishCursorCatalog } from "@/components/application/ai-chat/cursor-models";

const mocks = vi.hoisted(() => ({ getCliConfig: vi.fn(), getAppSettings: vi.fn(), listEngineModels: vi.fn(), cursorModelCatalog: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const engines = ["cursor", "codex", "claude"].map(id => ({ id, enabled: true, available: true })) as EngineInfo[];
const models = { cursor: "opus-high", codex: "missing-codex" };
const providers = {};

describe("useEngineModels task isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: EngineModelsState;
  const pinModels = vi.fn(async (_updates: Record<string, string>) => {});
  function Harness({ scope = "task" }: { scope?: "task" | "chat" }) {
    state = useEngineModels(engines, models, pinModels, providers, undefined, scope);
    return null;
  }
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCliConfig.mockResolvedValue({});
    mocks.getAppSettings.mockResolvedValue({});
    mocks.listEngineModels.mockImplementation(async (engine: string) => ({ authoritative: true, models: [
      { id: engine === "cursor" ? "opus-high" : `${engine}-default`, name: "Catalog model" },
    ] }));
    mocks.cursorModelCatalog.mockResolvedValue([{ id: "opus", name: "Opus", parameters: [
      { id: "effort", name: "Effort", options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
    ] }]);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("does not pin unset or stale models, collapse slugs, seed parameters, or publish a catalog", async () => {
    const previousParams = localStorage.getItem("ccgui.cursor.model-parameters");
    const previousCatalog = publishedCursorCatalog();
    const existingParams = JSON.stringify({ opus: { effort: "low" } });
    const existingCatalog = [{ id: "existing-chat-model", name: "Chat model", parameters: [] }];
    try {
      localStorage.setItem("ccgui.cursor.model-parameters", existingParams);
      publishCursorCatalog(existingCatalog);
      await act(async () => root.render(<Harness />));
      expect(state!.modelsByEngine.cursor.map(model => model.id)).toEqual(["opus-high"]);
      expect(state!.modelsByEngine.codex.map(model => model.id)).toEqual(["codex-default"]);
      expect(state!.cursorPickerModels).toEqual([]);
      expect(pinModels).not.toHaveBeenCalled();
      expect(mocks.cursorModelCatalog).not.toHaveBeenCalled();
      await act(async () => state!.refresh());
      expect(mocks.listEngineModels).toHaveBeenCalledTimes(6);
      expect(pinModels).not.toHaveBeenCalled();
      expect(mocks.cursorModelCatalog).not.toHaveBeenCalled();
      expect(localStorage.getItem("ccgui.cursor.model-parameters")).toBe(existingParams);
      expect(publishedCursorCatalog()).toEqual(existingCatalog);
    } finally {
      if (previousParams === null) localStorage.removeItem("ccgui.cursor.model-parameters"); else localStorage.setItem("ccgui.cursor.model-parameters", previousParams);
      publishCursorCatalog(previousCatalog);
    }
  });

  it.each(["config", "catalog"])("rejects failed %s refresh and retains the previous catalog without repairing selections", async (failure) => {
    await act(async () => root.render(<Harness />));
    const priorCatalog = state!.catalogs;
    if (failure === "config") mocks.getCliConfig.mockRejectedValue(new Error("config offline"));
    else mocks.listEngineModels.mockRejectedValue(new Error("catalog offline"));
    await act(async () => { await expect(state!.refresh()).rejects.toThrow(); });
    expect(state!.catalogs.cursor).toEqual(priorCatalog.cursor);
    expect(state!.modelsByEngine.cursor.map(model => model.id)).toEqual(["opus-high"]);
    if (failure === "config") expect(state!.configStatus).toBe("error");
    else expect(state!.failedEngines.cursor).toBeTruthy();
    expect(pinModels).not.toHaveBeenCalled();
    expect(mocks.cursorModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps the normal chat default repair behavior", async () => {
    const previousParams = localStorage.getItem("ccgui.cursor.model-parameters");
    const previousCatalog = publishedCursorCatalog();
    try {
      await act(async () => root.render(<Harness scope="chat" />));
      expect(mocks.cursorModelCatalog).toHaveBeenCalled();
      expect(pinModels.mock.calls.some(([updates]) => updates.codex === "codex-default" && updates.claude === "claude-default")).toBe(true);
    } finally {
      if (previousParams === null) localStorage.removeItem("ccgui.cursor.model-parameters"); else localStorage.setItem("ccgui.cursor.model-parameters", previousParams);
      publishCursorCatalog(previousCatalog);
    }
  });
});
