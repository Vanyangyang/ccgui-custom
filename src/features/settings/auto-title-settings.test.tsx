import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, AutoTitleModel } from "@/lib/ipc";

// GeneralSection reads settings on mount; updateAppSettings is the
// persistence assertion point.
const { getAppSettings, updateAppSettings, autoTitleModels } = vi.hoisted(() => {
  const getAppSettings = vi.fn();
  return {
    getAppSettings,
    updateAppSettings: vi.fn(async (settings: AppSettings) => {
      getAppSettings.mockResolvedValue(settings);
      return null;
    }),
    autoTitleModels: vi.fn<() => Promise<AutoTitleModel[]>>(async () => [
      { engine: "claude", provider: "Anthropic", id: "sonnet", name: "Sonnet", resolvedModel: "sonnet", supportsEffort: true },
      { engine: "claude", provider: "Anthropic", id: "opus", name: "Opus", resolvedModel: "opus", supportsEffort: true },
      { engine: "claude", provider: "Anthropic", id: "haiku", name: "Haiku", resolvedModel: "haiku", supportsEffort: false },
      { engine: "codex", provider: "OpenAI", id: "gpt-6", name: "GPT-6", resolvedModel: "gpt-6", supportsEffort: true },
    ]),
  };
});
vi.mock("@/lib/ipc", () => ({
  ipc: new Proxy(
    { getAppSettings, updateAppSettings, autoTitleModels },
    {
      get: (target, prop) =>
        prop in target ? Reflect.get(target, prop) : async () => null,
    },
  ),
}));
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isWeb: false,
}));

import i18n from "@/lib/i18n";
import { GeneralSection } from "./GeneralSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lacks CSS.escape, which react-aria's listbox calls when a Select opens.
if (typeof window.CSS === "undefined" || typeof window.CSS.escape !== "function") {
  const css = (window.CSS ?? {}) as { escape?: (value: string) => string };
  css.escape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  window.CSS = css as typeof CSS;
}

const SETTINGS = {
  theme: "light",
  titlebar: "native",
  language: "zh",
  sidebarThreadLimit: 5,
  fontFamily: "",
  fontFile: "",
  codeFontFamily: "",
  codeFontFile: "",
  composerSendShortcut: "enter",
  thinkingAutoCollapse: true,
  customModels: {},
} as unknown as AppSettings;

/** react-aria pairs pointerdown + click; dispatch the whole sequence. */
async function press(el: Element) {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function row(anchor: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-setting-anchor="${anchor}"]`);
  if (!el) throw new Error(`row not rendered: ${anchor}`);
  return el;
}

function autoTitleSwitch(): HTMLInputElement {
  const el = row("autoTitle").querySelector<HTMLInputElement>('input[role="switch"]');
  if (!el) throw new Error("no auto-title switch");
  return el;
}

function modelTrigger(): HTMLButtonElement {
  const el = row("autoTitleModel").querySelector("button");
  if (!el) throw new Error("no naming-model select");
  return el;
}

function effortTrigger(): HTMLButtonElement {
  return row("autoTitleEffort").querySelector("button")!;
}

async function pick(trigger: HTMLButtonElement, label: string) {
  await press(trigger);
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((el) => el.textContent?.trim() === label);
  if (!option) throw new Error(`option not rendered: ${label}`);
  await press(option);
  await flush();
}

describe("General → 行为 auto-naming rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(settings: AppSettings) {
    getAppSettings.mockResolvedValue(settings);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<GeneralSection />);
    });
    await flush();
  }

  beforeEach(() => {
    localStorage.clear();
    getAppSettings.mockReset();
    updateAppSettings.mockClear();
    autoTitleModels.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("defaults to off with Sonnet / xhigh shown and the selectors disabled", async () => {
    await mount(SETTINGS);
    expect(autoTitleSwitch().checked).toBe(false);
    expect(row("autoTitle").textContent).toContain(i18n.t("settings.autoTitleDesc"));
    expect(modelTrigger().disabled).toBe(true);
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelSonnet"));
    expect(effortTrigger().disabled).toBe(true);
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortXhigh"));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("preserves explicit Claude model and low effort without saving on read", async () => {
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleModel: "opus", autoTitleEffort: "low" });
    expect(modelTrigger().textContent).toContain("Opus");
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortLow"));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it.each(["codex", "pi"])("keeps %s missing effort at low", async (engine) => {
    autoTitleModels.mockResolvedValueOnce([{
      engine, provider: engine, id: "model", name: "Model", resolvedModel: "model", supportsEffort: true,
    }]);
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: engine, autoTitleModel: "model" });
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortLow"));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("turning it on persists the switch and enables the model select", async () => {
    await mount(SETTINGS);
    await act(async () => autoTitleSwitch().click());
    await flush();

    expect(updateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoTitleEnabled: true }),
    );
    expect(autoTitleSwitch().checked).toBe(true);
    expect(modelTrigger().disabled).toBe(false);
  });

  it("picking Haiku persists the naming model", async () => {
    await mount({ ...SETTINGS, autoTitleEnabled: true });
    await press(modelTrigger());
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (el) => el.textContent?.trim() === i18n.t("settings.autoTitleModelHaiku"),
    );
    if (!option) throw new Error("Haiku option not rendered");
    await press(option);
    await flush();

    expect(updateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoTitleEngine: "claude", autoTitleModel: "haiku" }),
    );
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelHaiku"));
    expect(effortTrigger().disabled).toBe(true);
  });

  it("saves and reopens independent picks without changing chat defaults", async () => {
    const settings = { ...SETTINGS, autoTitleEnabled: true,
      defaultModels: { claude: "haiku", codex: "gpt-6" },
      defaultEfforts: { claude: "medium", codex: "xhigh" } } as AppSettings;
    await mount(settings);
    await pick(modelTrigger(), "GPT-6 · Codex CLI · OpenAI");
    // Source and raw id are persisted together in exactly one save.
    expect(updateAppSettings).toHaveBeenCalledTimes(1);
    expect(updateAppSettings.mock.calls[0][0]).toMatchObject({ autoTitleEngine: "codex", autoTitleModel: "gpt-6" });
    await pick(effortTrigger(), i18n.t("chat.effortUltra"));
    const saved = updateAppSettings.mock.calls.at(-1)![0];
    expect(saved).toMatchObject({ autoTitleEngine: "codex", autoTitleModel: "gpt-6", autoTitleEffort: "ultra",
      defaultModels: settings.defaultModels, defaultEfforts: settings.defaultEfforts });
    await act(async () => root.unmount());
    container.remove();
    await mount(saved);
    expect(modelTrigger().textContent).toContain("GPT-6 · Codex CLI · OpenAI");
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortUltra"));
    await act(async () => autoTitleSwitch().click());
    await flush();
    const disabled = updateAppSettings.mock.calls.at(-1)![0];
    expect(disabled).toMatchObject({ autoTitleEnabled: false, autoTitleEngine: "codex", autoTitleModel: "gpt-6", autoTitleEffort: "ultra" });
    expect(disabled.defaultModels).toEqual(settings.defaultModels);
    expect(disabled.defaultEfforts).toEqual(settings.defaultEfforts);
    await act(async () => root.unmount());
    container.remove();
    await mount(disabled);
    expect(autoTitleSwitch().checked).toBe(false);
    expect(modelTrigger().disabled).toBe(true);
    expect(effortTrigger().disabled).toBe(true);
  });

  it("retains effort on unsupported models and restores it when switching back", async () => {
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEffort: "high" });
    await pick(modelTrigger(), "Haiku");
    expect(effortTrigger().disabled).toBe(true);
    expect(row("autoTitleEffort").textContent).toContain(i18n.t("settings.autoTitleEffortUnsupported"));
    expect(updateAppSettings.mock.calls.at(-1)![0].autoTitleEffort).toBe("high");
    await pick(modelTrigger(), "Opus");
    expect(effortTrigger().disabled).toBe(false);
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortHigh"));
  });

  it("retains missing saved models and maps legacy Claude ultra to max without saving", async () => {
    await mount({ ...SETTINGS, autoTitleModel: "invalid", autoTitleEffort: "invalid", autoTitleEnabled: false });
    expect(modelTrigger().textContent).toContain("invalid · Claude Code");
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelUnavailable"));
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortXhigh"));
    expect(autoTitleSwitch().checked).toBe(false);
    expect(updateAppSettings).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
    await mount({ ...SETTINGS, autoTitleEffort: "ultra" });
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortMax"));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("keeps a missing source selected and lets the user choose a callable source", async () => {
    autoTitleModels.mockResolvedValueOnce([
      { engine: "claude", provider: "Anthropic", id: "sonnet", name: "Sonnet", resolvedModel: "sonnet", supportsEffort: true },
    ]);
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "codex", autoTitleModel: "gpt-6", autoTitleEffort: "ultra" });
    expect(modelTrigger().textContent).toContain("gpt-6 · Codex CLI");
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelUnavailable"));
    expect(row("autoTitleModel").textContent).toContain(i18n.t("settings.autoTitleModelUnavailableDesc"));
    expect(modelTrigger().disabled).toBe(false);
    expect(effortTrigger().disabled).toBe(true);
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortUltra"));
    expect(updateAppSettings).not.toHaveBeenCalled();
    await pick(modelTrigger(), i18n.t("settings.autoTitleModelSonnet"));
    expect(updateAppSettings.mock.calls.at(-1)![0]).toMatchObject({ autoTitleEngine: "claude", autoTitleModel: "sonnet", autoTitleEffort: "ultra" });
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortMax"));
  });

  it("distinguishes identical model ids returned by different sources", async () => {
    autoTitleModels.mockResolvedValueOnce([
      { engine: "claude", provider: "Anthropic", id: "shared-model", name: "Shared model", resolvedModel: "shared-model", supportsEffort: true },
      { engine: "codex", provider: "OpenAI", id: "shared-model", name: "Shared model", resolvedModel: "shared-model", supportsEffort: true },
    ]);
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "claude", autoTitleModel: "shared-model" });
    expect(modelTrigger().textContent).toContain("Shared model");
    await pick(modelTrigger(), "Shared model · Codex CLI · OpenAI");
    expect(updateAppSettings).toHaveBeenCalledTimes(1);
    expect(updateAppSettings.mock.calls[0][0]).toMatchObject({ autoTitleEngine: "codex", autoTitleModel: "shared-model" });
    expect(modelTrigger().textContent).toContain("Shared model · Codex CLI · OpenAI");
  });

  it("uses Codex's six effort options and Claude's five without rewriting stored effort", async () => {
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "codex", autoTitleModel: "gpt-6", autoTitleEffort: "ultra" });
    await press(effortTrigger());
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(6);
    expect([...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim()))
      .toContain(i18n.t("chat.effortUltra"));
    await press(effortTrigger());
    await pick(modelTrigger(), "Opus");
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortMax"));
    expect(updateAppSettings.mock.calls.at(-1)![0].autoTitleEffort).toBe("ultra");
    await press(effortTrigger());
    const options = [...document.body.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(5);
    expect(options.map((option) => option.textContent?.trim())).not.toContain(i18n.t("chat.effortUltra"));
    expect(options.map((option) => option.textContent?.trim())).toContain(i18n.t("chat.effortMax"));
    // Max is already selected by legacy ultra normalization. Change away
    // first so selecting Max exercises a real user change and persistence.
    const highOption = options.find((option) => option.textContent?.trim() === i18n.t("chat.effortHigh"));
    if (!highOption) throw new Error("Claude high option not rendered");
    await press(highOption);
    await flush();
    await pick(effortTrigger(), i18n.t("chat.effortMax"));
    expect(updateAppSettings.mock.calls.at(-1)![0]).toMatchObject({ autoTitleEngine: "claude", autoTitleModel: "opus", autoTitleEffort: "max" });
  });

  it("treats legacy catalog entries without source metadata as Claude", async () => {
    autoTitleModels.mockResolvedValueOnce([
      { id: "sonnet", name: "Sonnet", resolvedModel: "sonnet", supportsEffort: true },
      { id: "haiku", name: "Haiku", resolvedModel: "haiku", supportsEffort: false },
    ] as AutoTitleModel[]);
    await mount({ ...SETTINGS, autoTitleEnabled: true });
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelSonnet"));
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortXhigh"));
    expect(updateAppSettings).not.toHaveBeenCalled();
    await pick(modelTrigger(), "Haiku");
    expect(updateAppSettings.mock.calls.at(-1)![0]).toMatchObject({ autoTitleEngine: "claude", autoTitleModel: "haiku" });
  });

  it("uses the selected source's default without showing a Claude model", async () => {
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "codex", autoTitleModel: null });
    expect(modelTrigger().textContent).toContain("GPT-6 · Codex CLI · OpenAI");
    expect(modelTrigger().textContent).not.toContain(i18n.t("settings.autoTitleModelUnavailable"));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("uses Pi's native capability list and keeps legacy highest effort compatible", async () => {
    autoTitleModels.mockResolvedValueOnce([{
      engine: "pi", provider: "Google", id: "google/gemini", name: "Gemini",
      resolvedModel: "google/gemini", supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    }]);
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "pi",
      autoTitleModel: "google/gemini", autoTitleEffort: "ultra" });
    expect(modelTrigger().textContent).toContain("Gemini");
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortMax"));
    await press(effortTrigger());
    const options = [...document.body.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(5);
    expect(options.map((option) => option.textContent?.trim())).not.toContain(i18n.t("chat.effortUltra"));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("retains saved source and model when the callable directory is empty", async () => {
    autoTitleModels.mockResolvedValueOnce([]);
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "codex", autoTitleModel: "gpt-6", autoTitleEffort: "ultra" });
    expect(modelTrigger().textContent).toContain("gpt-6 · Codex CLI");
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelUnavailable"));
    expect(modelTrigger().disabled).toBe(true);
    expect(effortTrigger().disabled).toBe(true);
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("keeps saved picks when saving fails", async () => {
    await mount({ ...SETTINGS, autoTitleEnabled: true });
    updateAppSettings.mockRejectedValueOnce(new Error("fixture save failure"));
    await pick(modelTrigger(), "Opus");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("fixture save failure");
    expect(modelTrigger().textContent).toContain(i18n.t("settings.autoTitleModelSonnet"));
  });

  it("keeps saved values and blocks picks when the model directory is unavailable", async () => {
    autoTitleModels.mockRejectedValueOnce(new Error("fixture catalog failure"));
    await mount({ ...SETTINGS, autoTitleEnabled: true, autoTitleEngine: "codex", autoTitleModel: "gpt-6", autoTitleEffort: "ultra" });
    expect(modelTrigger().disabled).toBe(true);
    expect(modelTrigger().textContent).toContain("gpt-6 · Codex CLI");
    expect(row("autoTitleModel").textContent).toContain(i18n.t("settings.autoTitleModelsFailed"));
    expect(effortTrigger().textContent).toContain(i18n.t("chat.effortUltra"));
    expect(effortTrigger().disabled).toBe(true);
    expect(autoTitleSwitch().checked).toBe(true);
    expect(updateAppSettings).not.toHaveBeenCalled();
  });
});
