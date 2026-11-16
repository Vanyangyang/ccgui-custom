import { ipc, type AppSettings } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import {
  applyBackdropPreferences,
  CHAT_BACKDROP_STORAGE_KEY,
  notifyBackdropThemeChanged,
  readCachedBackdropPreferences,
} from "./backdrop";

/** localStorage key holding the last applied theme, read pre-paint by bootstrap.tsx. */
export const THEME_STORAGE_KEY = "boardui:theme";
/** Window event fired by a theme toggle control; carries "dark" | "light". */
export const THEME_CHANGE_EVENT = "boardui:theme-change";

export const THEME_PRESETS = ["mist", "warm", "aurora", "classic"] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];
export const DEFAULT_THEME_PRESET: ThemePreset = "mist";

export const ACCENT_COLORS = ["blue", "indigo", "violet", "teal", "emerald", "amber"] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];
export const DEFAULT_ACCENT_COLOR: AccentColor = "blue";

export const THEME_PRESET_STORAGE_KEY = "ccgui-next.theme-preset:v1";
export const ACCENT_COLOR_STORAGE_KEY = "ccgui-next.accent-color:v1";

function readStorageSafe(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorageSafe(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage access errors in restricted environments.
  }
}

export function normalizeThemePreset(value?: string | null): ThemePreset {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "mist" ||
    normalized === "warm" ||
    normalized === "aurora" ||
    normalized === "classic"
  ) {
    return normalized;
  }
  return DEFAULT_THEME_PRESET;
}

export function normalizeAccentColor(value?: string | null): AccentColor {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "blue" ||
    normalized === "indigo" ||
    normalized === "violet" ||
    normalized === "teal" ||
    normalized === "emerald" ||
    normalized === "amber"
  ) {
    return normalized;
  }
  return DEFAULT_ACCENT_COLOR;
}

export function applyAppearanceTokens(
  opts: { themePreset?: string | null; accentColor?: string | null },
  persistCache = true,
): void {
  const preset = normalizeThemePreset(opts.themePreset);
  const accent = normalizeAccentColor(opts.accentColor);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.themePreset = preset;
    document.documentElement.dataset.accent = accent;
  }
  if (persistCache) {
    writeStorageSafe(THEME_PRESET_STORAGE_KEY, preset);
    writeStorageSafe(ACCENT_COLOR_STORAGE_KEY, accent);
  }
  notifyBackdropThemeChanged();
}

export function readCachedAppearance(): { themePreset: ThemePreset; accentColor: AccentColor } {
  return {
    themePreset: normalizeThemePreset(readStorageSafe(THEME_PRESET_STORAGE_KEY)),
    accentColor: normalizeAccentColor(readStorageSafe(ACCENT_COLOR_STORAGE_KEY)),
  };
}

/**
 * Apply the persisted theme to the document root.
 * "system" resolves through the OS color-scheme media query.
 */
export function applyTheme(theme: string): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  ipc.setWindowTheme(dark).catch(() => {});
  // Mirror the applied theme into storage for bootstrap.tsx's pre-paint read.
  writeStorageSafe(THEME_STORAGE_KEY, dark ? "dark" : "light");
  notifyBackdropThemeChanged();
}

export function applyAppearanceFromSettings(
  settings: Pick<AppSettings, "theme" | "themePreset" | "accentColor"> &
    Partial<Pick<AppSettings, "chatBackdrop">>,
): void {
  applyTheme(settings.theme);
  applyAppearanceTokens({
    themePreset: settings.themePreset,
    accentColor: settings.accentColor,
  });
  if ("chatBackdrop" in settings) {
    applyBackdropPreferences(settings.chatBackdrop);
  }
}

/** Persist a theme change (from a toggle control) back into app settings. */
export function bindThemeChangePersistence(): () => void {
  const onChange = (event: Event) => {
    const theme = (event as CustomEvent<string>).detail === "dark" ? "dark" : "light";
    ipc
      .getAppSettings()
      .then((settings) => ipc.updateAppSettings({ ...settings, theme }))
      .catch(() => {});
  };
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

/** Follow OS color-scheme flips while the saved theme is "system". Bound at
 * the app root (not the settings page) so it works without opening Settings.
 * The current setting is re-read on every flip, so no re-subscription is
 * needed when the user changes themes. */
export function bindSystemThemeSync(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    ipc
      .getAppSettings()
      .then((settings) => {
        if (settings.theme === "system") applyTheme("system");
      })
      .catch(() => {});
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Keep theme/preset/accent in sync when settings://changed broadcasts from
 *  another surface or window. */
export function bindSettingsAppearanceSync(): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let readGeneration = 0;
  const sync = () => {
    const turn = ++readGeneration;
    const reader =
      typeof ipc.refreshAppSettings === "function"
        ? ipc.refreshAppSettings()
        : ipc.getAppSettings();
    void reader
      .then((settings) => {
        if (disposed || turn !== readGeneration || !settings) return;
        applyAppearanceFromSettings(settings);
      })
      .catch(() => {});
  };
  void listen("settings://changed", sync)
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    readGeneration++;
    unlisten?.();
  };
}

/** Mirror cross-window localStorage updates (used by detached plugin windows). */
export function bindCachedAppearanceSync(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== null &&
      event.key !== THEME_PRESET_STORAGE_KEY &&
      event.key !== ACCENT_COLOR_STORAGE_KEY &&
      event.key !== CHAT_BACKDROP_STORAGE_KEY
    ) {
      return;
    }
    if (event.key === null || event.key === CHAT_BACKDROP_STORAGE_KEY) {
      applyBackdropPreferences(readCachedBackdropPreferences(), false);
    }
    if (
      event.key === null ||
      event.key === THEME_PRESET_STORAGE_KEY ||
      event.key === ACCENT_COLOR_STORAGE_KEY
    ) {
      applyAppearanceTokens(readCachedAppearance(), false);
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
