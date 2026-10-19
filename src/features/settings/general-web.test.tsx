import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/lib/ipc";

const { getAppSettings, getCurrentWindow, autoTitleModels } = vi.hoisted(() => ({
  getAppSettings: vi.fn(),
  getCurrentWindow: vi.fn(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'metadata')");
  }),
  autoTitleModels: vi.fn(async () => [
    { id: "sonnet", name: "Sonnet", resolvedModel: "sonnet", supportsEffort: true },
  ]),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: new Proxy(
    { getAppSettings, autoTitleModels },
    {
      get: (target, prop) =>
        prop in target ? Reflect.get(target, prop) : async () => null,
    },
  ),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));
vi.mock("@/lib/platform", () => ({
  IS_WINDOWS: true,
  isWeb: true,
  pickFile: vi.fn(async () => null),
  setWebviewZoom: vi.fn(),
}));
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isWeb: true,
}));

import i18n from "@/lib/i18n";
import { GeneralSection } from "./GeneralSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS = {
  theme: "light",
  titlebar: "mac",
  language: "zh",
  sidebarThreadLimit: 5,
  fontFamily: "",
  fontFile: "",
  codeFontFamily: "",
  codeFontFile: "",
  composerSendShortcut: "enter",
  thinkingAutoCollapse: true,
  autoTitleEnabled: true,
  autoTitleModel: "sonnet",
  autoTitleEffort: "low",
  customModels: {},
} as unknown as AppSettings;

describe("General → Windows WebUI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0",
    );
    getAppSettings.mockReset().mockResolvedValue(SETTINGS);
    getCurrentWindow.mockClear();
    autoTitleModels.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders regular settings without accessing a native window or showing its controls", async () => {
    await act(async () => root.render(<GeneralSection />));

    expect(navigator.userAgent).toContain("Windows");
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-setting-anchor="titlebar"]')).toBeNull();
    expect([...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === i18n.t("settings.restartNow"),
    )).toBe(false);
    expect(container.querySelector('[data-setting-anchor="theme"]')?.textContent)
      .toContain(i18n.t("settings.themeLight"));
    expect(container.querySelector<HTMLInputElement>(
      '[data-setting-anchor="autoTitle"] input[role="switch"]',
    )?.checked).toBe(true);
    expect(autoTitleModels).toHaveBeenCalledTimes(1);
    const modelButton = container.querySelector<HTMLButtonElement>(
      '[data-setting-anchor="autoTitleModel"] button',
    );
    expect(modelButton).not.toBeNull();
    expect(modelButton?.disabled).toBe(false);
    expect(modelButton?.textContent).toContain(i18n.t("settings.autoTitleModelSonnet"));
  });
});
