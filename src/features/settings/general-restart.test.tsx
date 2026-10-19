import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/lib/ipc";

const { getAppSettings, updateAppSettings, restartApp, isDecorated } = vi.hoisted(() => ({
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(async () => null),
  restartApp: vi.fn<() => Promise<void>>(),
  isDecorated: vi.fn(async () => true),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: new Proxy(
    { getAppSettings, updateAppSettings, restartApp },
    {
      get: (target, prop) =>
        prop in target ? Reflect.get(target, prop) : async () => null,
    },
  ),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isDecorated }),
}));
vi.mock("@/lib/platform", () => ({
  IS_WINDOWS: true,
  isWeb: false,
  pickFile: vi.fn(async () => null),
  setWebviewZoom: vi.fn(),
}));
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isWeb: false,
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
  customModels: {},
} as unknown as AppSettings;

function restartButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === i18n.t("settings.restartNow"),
  );
  if (!button) throw new Error("restart button not rendered");
  return button;
}

function deferredRestart() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("General → restart feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    localStorage.clear();
    getAppSettings.mockReset().mockResolvedValue(SETTINGS);
    updateAppSettings.mockClear();
    restartApp.mockReset();
    isDecorated.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<GeneralSection />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows a restart failure, preserves settings, and allows a retry", async () => {
    const first = deferredRestart();
    const retry = deferredRestart();
    restartApp.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const button = restartButton(container);
    expect(button.disabled).toBe(false);

    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    await act(async () => first.reject("Cannot release the instance window marker"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      i18n.t("settings.restartFailed", { error: "Cannot release the instance window marker" }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Cannot release the instance window marker",
    );
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[data-setting-anchor="titlebar"]')?.textContent)
      .toContain(i18n.t("settings.titlebarMac"));
    expect(container.querySelector('[data-setting-anchor="theme"]')?.textContent)
      .toContain(i18n.t("settings.themeLight"));
    expect(updateAppSettings).not.toHaveBeenCalled();

    await act(async () => button.click());
    expect(restartApp).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => retry.resolve());
    expect(button.disabled).toBe(false);
  });

  it("submits only one restart when clicks arrive before the pending state commits", async () => {
    const request = deferredRestart();
    restartApp.mockReturnValue(request.promise);
    const button = restartButton(container);

    await act(async () => {
      button.click();
      button.click();
    });
    expect(restartApp).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(restartApp).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve());
    expect(button.disabled).toBe(false);
  });
});
