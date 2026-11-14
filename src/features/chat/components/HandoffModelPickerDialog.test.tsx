import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { HandoffCompressionSelection } from "@/lib/ipc";
import { PSEUDO_LOCAL, CLI_CONFIG_CHANGED_EVENT } from "@/features/settings/providers";
import { chooseHandoffModel } from "../handoff-model-picker";

const mocks = vi.hoisted(() => ({ listEngines: vi.fn(), getCliConfig: vi.fn(), getAppSettings: vi.fn(),
  listEngineModels: vi.fn(), cursorModelCatalog: vi.fn(), setCompressionSelection: vi.fn(),
  setCompressionMode: vi.fn(), compressHandoff: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("../session-cleanup", () => ({ useHandoffStore: (select: (state: typeof mocks) => unknown) => select(mocks) }));
vi.mock("@/features/browser/occlusion", () => ({ useBrowserOcclusion: () => {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("imperative handoff model picker", () => {
  const selection = { engine: "cursor" as const, model: "saved-model", providerId: PSEUDO_LOCAL };
  const originalLanguage = i18n.language;
  let result: Promise<HandoffCompressionSelection | null> | undefined;
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text)!;
  async function press(element: Element) {
    expect(element).toBeTruthy();
    await act(async () => (element as HTMLElement).click());
  }
  async function open() {
    await act(async () => { result = chooseHandoffModel({ workspacePath: "/workspace", selection }); });
  }
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
    mocks.listEngines.mockResolvedValue([{ id: "cursor", enabled: true, available: true }]);
    mocks.getCliConfig.mockResolvedValue({});
    mocks.getAppSettings.mockResolvedValue({ customModels: {}, customModelLabels: {} });
    mocks.listEngineModels.mockResolvedValue({ authoritative: true, models: [{ id: "saved-model", name: "Saved model" }, { id: "new-model", name: "New model" }] });
    await i18n.changeLanguage("en");
  });
  afterEach(async () => {
    const cancel = button(i18n.t("common.cancel"));
    if (cancel) await press(cancel);
    if (result) await result;
    result = undefined;
    vi.unstubAllGlobals();
    await i18n.changeLanguage(originalLanguage);
  });

  it("returns the chosen model only on confirm, without calling a model or writing preferences", async () => {
    // Do not await the dialog result until the user closes it.
    await open();
    expect(document.body.textContent).not.toContain(PSEUDO_LOCAL);
    await press(document.querySelector('[role="group"] button')!);
    await press(button("New model"));
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.compressHandoff).not.toHaveBeenCalled();
    await press(button(i18n.t("common.confirm")));
    expect(await result).toEqual({ ...selection, model: "new-model" });
    expect(selection.model).toBe("saved-model");
    expect(document.querySelector("[data-handoff-model-picker-root]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
    expect(mocks.compressHandoff).not.toHaveBeenCalled();
  });

  it.each(["cancel", "escape"])("resolves null on %s and removes discovery listeners despite late results", async action => {
    const discovery = Promise.withResolvers<{ id: string; enabled: boolean; available: boolean }[]>();
    mocks.listEngines.mockReturnValue(discovery.promise);
    await open();
    if (action === "cancel") await press(button(i18n.t("common.cancel")));
    else {
      // React Aria moves focus after layout. Wait for the actual focus trap;
      // sending Escape to body before it settles never exercises the dialog.
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true));
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    }
    expect(await result).toBeNull();
    await act(async () => {
      discovery.resolve([{ id: "cursor", enabled: true, available: true }]);
      window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT));
    });
    expect(mocks.listEngines).toHaveBeenCalledTimes(1);
    expect(mocks.listEngineModels).not.toHaveBeenCalled();
    expect(mocks.compressHandoff).not.toHaveBeenCalled();
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(document.querySelector("[data-handoff-model-picker-root]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("discards a changed draft on cancel without changing stored Cursor preferences", async () => {
    const before = localStorage.getItem("ccgui.cursor.model-parameters");
    await open();
    await press(document.querySelector('[role="group"] button')!);
    await press(button("New model"));
    await press(button(i18n.t("common.cancel")));
    expect(await result).toBeNull();
    expect(selection.model).toBe("saved-model");
    expect(localStorage.getItem("ccgui.cursor.model-parameters")).toBe(before);
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.compressHandoff).not.toHaveBeenCalled();
    await open();
    await press(button(i18n.t("common.confirm")));
    expect(await result).toEqual(selection);
  });

  it("rejects a concurrent request and permits reopening after cancellation", async () => {
    await open();
    await expect(chooseHandoffModel({ workspacePath: "/other", selection })).rejects.toThrow("HANDOFF_MODEL_PICKER_BUSY");
    expect(document.querySelectorAll("[data-handoff-model-picker-root]")).toHaveLength(1);
    await press(button(i18n.t("common.cancel")));
    expect(await result).toBeNull();
    await open();
    await press(button(i18n.t("common.confirm")));
    expect(await result).toEqual(selection);
  });
});
