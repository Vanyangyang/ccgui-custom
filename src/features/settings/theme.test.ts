// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setWindowTheme, getAppSettings, refreshAppSettings, listenMock } = vi.hoisted(() => ({
  setWindowTheme: vi.fn(async () => {}),
  getAppSettings: vi.fn(),
  refreshAppSettings: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    setWindowTheme,
    getAppSettings,
    refreshAppSettings,
    updateAppSettings: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/transport", () => ({
  listen: listenMock,
}));

import {
  ACCENT_COLOR_STORAGE_KEY,
  applyAppearanceFromSettings,
  applyAppearanceTokens,
  bindCachedAppearanceSync,
  normalizeAccentColor,
  normalizeThemePreset,
  readCachedAppearance,
  THEME_PRESET_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./theme";

describe("theme appearance presets and accents", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.themePreset;
    delete document.documentElement.dataset.accent;
    document.documentElement.classList.remove("dark");
    setWindowTheme.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes unknown, blank, and uppercase theme presets and accents to defaults", () => {
    expect(normalizeThemePreset(undefined)).toBe("mist");
    expect(normalizeThemePreset(null)).toBe("mist");
    expect(normalizeThemePreset("")).toBe("mist");
    expect(normalizeThemePreset("invalid-preset")).toBe("mist");
    expect(normalizeThemePreset("  WARM  ")).toBe("warm");
    expect(normalizeThemePreset("Aurora")).toBe("aurora");
    expect(normalizeThemePreset("classic")).toBe("classic");

    expect(normalizeAccentColor(undefined)).toBe("blue");
    expect(normalizeAccentColor(null)).toBe("blue");
    expect(normalizeAccentColor("  ")).toBe("blue");
    expect(normalizeAccentColor("crimson")).toBe("blue");
    expect(normalizeAccentColor(" Violet ")).toBe("violet");
    expect(normalizeAccentColor("AMBER")).toBe("amber");
  });

  it("applies dataset attributes, dark class, and localStorage round-trip", () => {
    applyAppearanceFromSettings({
      theme: "dark",
      themePreset: "warm",
      accentColor: "emerald",
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.themePreset).toBe("warm");
    expect(document.documentElement.dataset.accent).toBe("emerald");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(window.localStorage.getItem(THEME_PRESET_STORAGE_KEY)).toBe("warm");
    expect(window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY)).toBe("emerald");
    expect(readCachedAppearance()).toEqual({
      themePreset: "warm",
      accentColor: "emerald",
    });

    applyAppearanceTokens({ themePreset: "aurora", accentColor: "teal" }, false);
    expect(document.documentElement.dataset.themePreset).toBe("aurora");
    expect(document.documentElement.dataset.accent).toBe("teal");
    expect(readCachedAppearance()).toEqual({
      themePreset: "warm",
      accentColor: "emerald",
    });
  });

  it("syncs appearance from cross-window storage events", () => {
    const stop = bindCachedAppearanceSync();
    window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, "aurora");
    window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, "indigo");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "unrelated-key",
      }),
    );
    expect(document.documentElement.dataset.themePreset).toBeUndefined();

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: THEME_PRESET_STORAGE_KEY,
        newValue: "aurora",
      }),
    );
    expect(document.documentElement.dataset.themePreset).toBe("aurora");
    expect(document.documentElement.dataset.accent).toBe("indigo");

    stop();
  });
});
