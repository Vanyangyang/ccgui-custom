// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    readBackdropImage: vi.fn(),
    setWindowTheme: vi.fn(async () => {}),
    getAppSettings: vi.fn(async () => ({})),
    refreshAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/transport", () => ({
  invoke: vi.fn(async () => undefined),
  isWeb: false,
  listen: vi.fn(async () => () => {}),
}));

import * as backdropModule from "@/features/settings/backdrop";
import {
  ACCENT_COLOR_STORAGE_KEY,
  DEFAULT_THEME_PRESET,
  THEME_PRESET_STORAGE_KEY,
} from "@/features/settings/theme";
import { PluginWindow } from "./bootstrap";
import type { DetachedSurfaceClient } from "./client";
import type { DetachedInit, DetachedSnapshot, DetachedStatus } from "./protocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createMockContext2D() {
  const gradient = () => ({ addColorStop: vi.fn() });
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    rect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    createLinearGradient: vi.fn(gradient),
    createRadialGradient: vi.fn(gradient),
  } as unknown as CanvasRenderingContext2D;
}

function createFakeDetachedClient(initialDark = false) {
  let dark = initialDark;
  let status: DetachedStatus = { phase: "opening" };
  let snapshot: DetachedSnapshot | undefined;
  const listeners = new Set<() => void>();
  const initPayload: DetachedInit = {
    windowId: "win-1",
    registrationId: "reg-1",
    label: "plugin-tab-test",
    pluginId: "fixture-workbench",
    tabId: "workbench",
    title: "合成插件工作台",
    rendererExport: "default",
    code: "",
    css: "",
    snapshot: { revision: 1, state: {} },
    dark,
    labels: {
      returnToMain: "返回主窗口",
      ownerUnavailable: "主窗口不可用",
      actionFailed: "操作失败",
      loading: "加载中",
    },
    nextSequence: 1,
    unresolvedSequences: [],
  };

  const client: DetachedSurfaceClient = {
    registerReturnGuard: () => () => {},
    init: async () => initPayload,
    getSnapshot: () => snapshot,
    getStatus: () => status,
    getDark: () => dark,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: async () => ({ value: null, snapshot: { revision: 1, state: {} }, sequence: 1 }),
    requestReturn: async () => {},
    discardAndReturn: async () => {},
    flush: async () => {},
    reconcile: async () => true,
    focusOwner: async () => {},
    status: async () => ({ ownerAvailable: true, closing: false }),
    dispose: () => {},
  };

  return {
    client,
    setDark(nextDark: boolean) {
      dark = nextDark;
      for (const listener of listeners) listener();
    },
    setSnapshot(nextSnapshot: DetachedSnapshot) {
      snapshot = nextSnapshot;
      status = { phase: "detached" };
      for (const listener of listeners) listener();
    },
  };
}

describe("PluginWindow backdrop, theme sync, and layout containment", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.themePreset = DEFAULT_THEME_PRESET;
    delete document.documentElement.dataset.accent;
    backdropModule.applyBackdropPreferences(backdropModule.DEFAULT_CHAT_BACKDROP, false);

    const mockCtx = createMockContext2D();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => mockCtx as unknown as RenderingContext,
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width: 1200,
          height: 760,
          top: 0,
          left: 0,
          right: 1200,
          bottom: 760,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    backdropModule.applyBackdropPreferences(backdropModule.DEFAULT_CHAT_BACKDROP, false);
    vi.restoreAllMocks();
  });

  it("reads cached backdrop on mount, preserves fixed overflow-hidden shell, and hides when preset is none", async () => {
    window.localStorage.setItem(
      backdropModule.CHAT_BACKDROP_STORAGE_KEY,
      JSON.stringify({
        ...backdropModule.DEFAULT_CHAT_BACKDROP,
        preset: "komorebi",
        speed: 0,
      }),
    );

    const fake = createFakeDetachedClient(false);
    await act(async () => {
      root.render(createElement(PluginWindow, { client: fake.client }));
    });

    const shell = host.querySelector("[data-plugin-window-root]") as HTMLElement;
    expect(shell).not.toBeNull();
    expect(shell.className).toContain("fixed");
    expect(shell.className).toContain("inset-0");
    expect(shell.className).toContain("overflow-hidden");
    expect(shell.className).toContain("isolate");
    expect(shell.querySelector("header")?.className).toContain("backdrop-blur-md");
    expect(shell.querySelector('[data-conversation-backdrop="komorebi"]')).not.toBeNull();

    await act(async () => {
      window.localStorage.setItem(
        backdropModule.CHAT_BACKDROP_STORAGE_KEY,
        JSON.stringify({
          ...backdropModule.DEFAULT_CHAT_BACKDROP,
          preset: "none",
        }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: backdropModule.CHAT_BACKDROP_STORAGE_KEY,
        }),
      );
    });

    expect(shell.querySelector("[data-conversation-backdrop]")).toBeNull();
  });

  it("syncs preset, accent, and backdrop across windows via storage events and notifies theme change on dark toggle", async () => {
    const notifySpy = vi.spyOn(backdropModule, "notifyBackdropThemeChanged");
    const fake = createFakeDetachedClient(false);

    await act(async () => {
      root.render(createElement(PluginWindow, { client: fake.client }));
    });

    const shell = host.querySelector("[data-plugin-window-root]") as HTMLElement;
    expect(shell.querySelector('[data-conversation-backdrop="pixel-wave"]')).not.toBeNull();

    await act(async () => {
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, "aurora");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_PRESET_STORAGE_KEY }));
      window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, "violet");
      window.dispatchEvent(new StorageEvent("storage", { key: ACCENT_COLOR_STORAGE_KEY }));
      window.localStorage.setItem(
        backdropModule.CHAT_BACKDROP_STORAGE_KEY,
        JSON.stringify({
          ...backdropModule.DEFAULT_CHAT_BACKDROP,
          preset: "bayer-dither",
          speed: 0,
        }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: backdropModule.CHAT_BACKDROP_STORAGE_KEY }),
      );
    });

    expect(document.documentElement.dataset.themePreset).toBe("aurora");
    expect(document.documentElement.dataset.accent).toBe("violet");
    expect(shell.querySelector('[data-conversation-backdrop="bayer-dither"]')).not.toBeNull();

    notifySpy.mockClear();
    await act(async () => {
      fake.setDark(true);
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });
});
