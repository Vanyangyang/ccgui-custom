import { useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { ipc, type ChatBackdropSettings } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";
import { readStoredJson, writeStored } from "@/lib/storage";
import type { AccentColor } from "./theme";

export const CHAT_BACKDROP_PRESETS = [
  "pixel-wave",
  "bayer-dither",
  "flickering-grid",
  "silk-ribbons",
  "komorebi",
  "swiss-cross",
  "blueprint-grid",
  "dot-constellation",
  "aurora-mesh",
  "topographic",
  "custom-image",
  "none",
] as const;

export type ChatBackdropPreset = (typeof CHAT_BACKDROP_PRESETS)[number];
export type ChatBackdropColorMode = "accent" | "custom";
export type ChatBackdropFit = "cover" | "contain" | "repeat";

export type RgbTriplet = [number, number, number];

export const DEFAULT_CHAT_BACKDROP: ChatBackdropSettings = {
  preset: "pixel-wave",
  opacity: 48,
  speed: 50,
  scale: 50,
  scrim: 78,
  colorMode: "accent",
  customColor: "#06b6d4",
  imageFile: "",
  blur: 6,
  fit: "cover",
  parallax: true,
};

export function isProceduralBackdropPreset(preset: ChatBackdropPreset): boolean {
  return preset !== "none" && preset !== "custom-image";
}

export interface ChatBackdropRecipe {
  id: "cyber-dither" | "sunlit-paper" | "deep-silk" | "calm-matrix" | "swiss-studio";
  labelKey: string;
  swatchPrimary: string;
  swatchSecondary: string;
  patch: Pick<
    ChatBackdropSettings,
    "preset" | "opacity" | "speed" | "scale" | "scrim" | "colorMode" | "customColor" | "parallax"
  >;
}

export const CHAT_BACKDROP_RECIPES: readonly ChatBackdropRecipe[] = [
  {
    id: "cyber-dither",
    labelKey: "settings.chatBackdropRecipeCyberDither",
    swatchPrimary: "#2563eb",
    swatchSecondary: "#38bdf8",
    patch: {
      preset: "bayer-dither",
      opacity: 46,
      speed: 40,
      scale: 52,
      scrim: 82,
      colorMode: "accent",
      customColor: "#06b6d4",
      parallax: true,
    },
  },
  {
    id: "sunlit-paper",
    labelKey: "settings.chatBackdropRecipeSunlitPaper",
    swatchPrimary: "#d97706",
    swatchSecondary: "#f59e0b",
    patch: {
      preset: "komorebi",
      opacity: 54,
      speed: 35,
      scale: 55,
      scrim: 80,
      colorMode: "custom",
      customColor: "#d97706",
      parallax: true,
    },
  },
  {
    id: "deep-silk",
    labelKey: "settings.chatBackdropRecipeDeepSilk",
    swatchPrimary: "#06b6d4",
    swatchSecondary: "#6366f1",
    patch: {
      preset: "silk-ribbons",
      opacity: 44,
      speed: 45,
      scale: 50,
      scrim: 82,
      colorMode: "custom",
      customColor: "#06b6d4",
      parallax: true,
    },
  },
  {
    id: "calm-matrix",
    labelKey: "settings.chatBackdropRecipeCalmMatrix",
    swatchPrimary: "#4f46e5",
    swatchSecondary: "#14b8a6",
    patch: {
      preset: "flickering-grid",
      opacity: 42,
      speed: 30,
      scale: 46,
      scrim: 84,
      colorMode: "accent",
      customColor: "#06b6d4",
      parallax: true,
    },
  },
  {
    id: "swiss-studio",
    labelKey: "settings.chatBackdropRecipeSwissStudio",
    swatchPrimary: "#0d9488",
    swatchSecondary: "#0284c7",
    patch: {
      preset: "swiss-cross",
      opacity: 38,
      speed: 0,
      scale: 45,
      scrim: 86,
      colorMode: "accent",
      customColor: "#06b6d4",
      parallax: true,
    },
  },
];

export const CHAT_BACKDROP_STORAGE_KEY = "ccgui-next.chat-backdrop:v1";

const ACCENT_PALETTE: Record<
  AccentColor,
  { light: { primary: RgbTriplet; secondary: RgbTriplet }; dark: { primary: RgbTriplet; secondary: RgbTriplet } }
> = {
  blue: {
    light: { primary: [37, 99, 235], secondary: [14, 165, 233] },
    dark: { primary: [96, 165, 250], secondary: [56, 189, 248] },
  },
  indigo: {
    light: { primary: [79, 70, 229], secondary: [14, 165, 233] },
    dark: { primary: [129, 140, 248], secondary: [56, 189, 248] },
  },
  violet: {
    light: { primary: [124, 58, 237], secondary: [236, 72, 153] },
    dark: { primary: [167, 139, 250], secondary: [244, 114, 182] },
  },
  teal: {
    light: { primary: [13, 148, 136], secondary: [6, 182, 212] },
    dark: { primary: [45, 212, 191], secondary: [34, 211, 238] },
  },
  emerald: {
    light: { primary: [5, 150, 105], secondary: [20, 184, 166] },
    dark: { primary: [52, 211, 153], secondary: [45, 212, 191] },
  },
  amber: {
    light: { primary: [217, 119, 6], secondary: [249, 115, 22] },
    dark: { primary: [251, 191, 36], secondary: [251, 146, 60] },
  },
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampNumber(Math.round(value), min, max);
}

export function normalizeBackdropPreset(value?: string | null): ChatBackdropPreset {
  const normalized = value?.trim().toLowerCase() ?? "";
  if ((CHAT_BACKDROP_PRESETS as readonly string[]).includes(normalized)) {
    return normalized as ChatBackdropPreset;
  }
  return "pixel-wave";
}

export function normalizeBackdropColorMode(value?: string | null): ChatBackdropColorMode {
  return value?.trim().toLowerCase() === "custom" ? "custom" : "accent";
}

export function normalizeBackdropFit(value?: string | null): ChatBackdropFit {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "contain" || normalized === "repeat") return normalized;
  return "cover";
}

export function normalizeBackdropHexColor(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_CHAT_BACKDROP.customColor;
}

function normalizeImageFile(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return "";
  return trimmed;
}

export function normalizeChatBackdrop(
  input?: Partial<ChatBackdropSettings> | null,
): ChatBackdropSettings {
  return {
    preset: normalizeBackdropPreset(input?.preset),
    opacity: clampInt(input?.opacity, 10, 100, DEFAULT_CHAT_BACKDROP.opacity),
    speed: clampInt(input?.speed, 0, 150, DEFAULT_CHAT_BACKDROP.speed),
    scale: clampInt(input?.scale, 20, 100, DEFAULT_CHAT_BACKDROP.scale),
    scrim: clampInt(input?.scrim, 0, 100, DEFAULT_CHAT_BACKDROP.scrim),
    colorMode: normalizeBackdropColorMode(input?.colorMode),
    customColor: normalizeBackdropHexColor(input?.customColor),
    imageFile: normalizeImageFile(input?.imageFile),
    blur: clampInt(input?.blur, 0, 24, DEFAULT_CHAT_BACKDROP.blur),
    fit: normalizeBackdropFit(input?.fit),
    parallax:
      typeof input?.parallax === "boolean" ? input.parallax : DEFAULT_CHAT_BACKDROP.parallax,
  };
}

export function applyBackdropRecipe(
  current: ChatBackdropSettings,
  recipe: ChatBackdropRecipe,
): ChatBackdropSettings {
  return normalizeChatBackdrop({ ...current, ...recipe.patch });
}

export function matchesBackdropRecipe(
  backdrop: ChatBackdropSettings,
  recipe: ChatBackdropRecipe,
): boolean {
  const p = recipe.patch;
  if (
    backdrop.preset !== p.preset ||
    backdrop.opacity !== p.opacity ||
    backdrop.speed !== p.speed ||
    backdrop.scale !== p.scale ||
    backdrop.scrim !== p.scrim ||
    backdrop.colorMode !== p.colorMode ||
    backdrop.parallax !== p.parallax
  ) {
    return false;
  }
  return (
    p.colorMode !== "custom" ||
    normalizeBackdropHexColor(backdrop.customColor) === normalizeBackdropHexColor(p.customColor)
  );
}

export function effectiveBackdropPreset(
  backdrop: ChatBackdropSettings,
  webMode = isWeb,
): ChatBackdropPreset {
  const preset = normalizeBackdropPreset(backdrop.preset);
  if (webMode && preset === "custom-image") {
    return "pixel-wave";
  }
  return preset;
}

function hexToRgb(hex: string): RgbTriplet {
  const normalized = normalizeBackdropHexColor(hex);
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return [r, g, b];
}

function rgbToHsl([r, g, b]: RgbTriplet): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RgbTriplet {
  const hn = ((h % 360) + 360) % 360;
  if (s <= 0) {
    const gray = Math.round(clampNumber(l, 0, 1) * 255);
    return [gray, gray, gray];
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hn < 60) [r1, g1, b1] = [c, x, 0];
  else if (hn < 120) [r1, g1, b1] = [x, c, 0];
  else if (hn < 180) [r1, g1, b1] = [0, c, x];
  else if (hn < 240) [r1, g1, b1] = [0, x, c];
  else if (hn < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function normalizeAccentKey(accent?: string | null): AccentColor {
  const normalized = accent?.trim().toLowerCase();
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
  return "blue";
}

/**
 * Clamp DIY/accent particle colors into theme-safe lightness bounds so pure
 * black/white custom picks or saturated neon shades never erode foreground text.
 */
export function resolveBackdropRgb(
  backdrop: ChatBackdropSettings,
  accent: string | undefined,
  isDark: boolean,
): { primary: RgbTriplet; secondary: RgbTriplet } {
  if (normalizeBackdropColorMode(backdrop.colorMode) !== "custom") {
    const entry = ACCENT_PALETTE[normalizeAccentKey(accent)];
    return isDark ? entry.dark : entry.light;
  }
  const [h, s, l] = rgbToHsl(hexToRgb(backdrop.customColor));
  const safeL = isDark ? clampNumber(l, 0.5, 0.78) : clampNumber(l, 0.36, 0.58);
  const hasChroma = s > 0.08;
  const safeS = hasChroma
    ? clampNumber(s, isDark ? 0.32 : 0.28, isDark ? 0.92 : 0.88)
    : s;
  const primary = hslToRgb([h, safeS, safeL]);
  const secondaryL = isDark
    ? clampNumber(safeL + 0.05, 0.5, 0.78)
    : clampNumber(safeL + 0.04, 0.36, 0.58);
  const secondary = hslToRgb([hasChroma ? h + 24 : h, safeS, secondaryL]);
  return { primary, secondary };
}

/**
 * Center reading corridor attenuation for the max-w-[750px] message column.
 * Returns a scalar in [0.12, 1] that preserves full pattern visibility in the
 * side wings while fading gently inside the central reading zone.
 */
export function corridorAttenuation(
  x: number,
  width: number,
  scrimPct: number,
  preview = false,
): number {
  if (!(width > 0)) return 1;
  const scrim = clampInt(scrimPct, 0, 100, DEFAULT_CHAT_BACKDROP.scrim);
  if (scrim === 0) return 1;
  const dist = Math.abs(x - width * 0.5);
  const halfCorridor = preview ? width * 0.24 : Math.min(400, width * 0.35);
  const feather = preview
    ? Math.max(36, width * 0.16)
    : Math.max(90, Math.min(200, width * 0.14));
  let edgeFactor: number;
  if (dist <= halfCorridor) {
    edgeFactor = 0;
  } else if (dist >= halfCorridor + feather) {
    edgeFactor = 1;
  } else {
    const t = (dist - halfCorridor) / feather;
    edgeFactor = t * t * (3 - 2 * t);
  }
  const minCenterWeight = 1 - (scrim / 100) * 0.88;
  return minCenterWeight + (1 - minCenterWeight) * edgeFactor;
}

export interface BackdropSnapshot {
  backdrop: ChatBackdropSettings;
  themeRevision: number;
}

function backdropSignature(value: ChatBackdropSettings): string {
  return JSON.stringify(value);
}

function domThemeSignature(): string {
  if (typeof document === "undefined") return "light|mist|blue";
  const root = document.documentElement;
  const dark = root.classList.contains("dark") ? "dark" : "light";
  const preset = root.dataset.themePreset ?? "mist";
  const accent = root.dataset.accent ?? "blue";
  return `${dark}|${preset}|${accent}`;
}

let currentBackdrop = { ...DEFAULT_CHAT_BACKDROP };
let currentSignature = backdropSignature(currentBackdrop);
let currentThemeSignature = domThemeSignature();
let currentSnapshot: BackdropSnapshot = {
  backdrop: currentBackdrop,
  themeRevision: 0,
};
const listeners = new Set<() => void>();

function emitSnapshot(nextBackdrop: ChatBackdropSettings, bumpTheme: boolean): void {
  currentBackdrop = nextBackdrop;
  currentSignature = backdropSignature(nextBackdrop);
  currentSnapshot = {
    backdrop: currentBackdrop,
    themeRevision: bumpTheme ? currentSnapshot.themeRevision + 1 : currentSnapshot.themeRevision,
  };
  listeners.forEach((listener) => listener());
}

function subscribeBackdrop(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getBackdropSnapshot(): BackdropSnapshot {
  return currentSnapshot;
}

export function useBackdropSnapshot(): BackdropSnapshot {
  return useSyncExternalStore(subscribeBackdrop, getBackdropSnapshot, getBackdropSnapshot);
}

export function readCachedBackdropPreferences(): ChatBackdropSettings {
  return (
    readStoredJson(CHAT_BACKDROP_STORAGE_KEY, (raw) =>
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? normalizeChatBackdrop(raw as Partial<ChatBackdropSettings>)
        : null,
    ) ?? { ...DEFAULT_CHAT_BACKDROP }
  );
}

export function applyBackdropPreferences(
  input?: Partial<ChatBackdropSettings> | null,
  persistCache = true,
): void {
  const normalized = normalizeChatBackdrop(input);
  if (persistCache) {
    writeStored(CHAT_BACKDROP_STORAGE_KEY, JSON.stringify(normalized));
  }
  const nextSignature = backdropSignature(normalized);
  if (nextSignature !== currentSignature) {
    emitSnapshot(normalized, false);
  }
}

export function notifyBackdropThemeChanged(): void {
  const nextTheme = domThemeSignature();
  if (nextTheme === currentThemeSignature) return;
  currentThemeSignature = nextTheme;
  emitSnapshot(currentBackdrop, true);
}

// ---------------------------------------------------------------------------
// Custom wallpaper loader + Blob URL cache
// ---------------------------------------------------------------------------

let activeObjectUrl: string | null = null;
let cachedImageLoad: { path: string; promise: Promise<string> } | null = null;

function revokeObjectUrlSafe(url: string | null): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ignore revoke failures in constrained test runtimes.
  }
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function ensureBackdropImageLoaded(
  path: string,
  options?: { force?: boolean },
): Promise<string> {
  const normalized = normalizeImageFile(path);
  if (!normalized) {
    cachedImageLoad = null;
    revokeObjectUrlSafe(activeObjectUrl);
    activeObjectUrl = null;
    return Promise.resolve("");
  }
  if (!options?.force && cachedImageLoad?.path === normalized) {
    return cachedImageLoad.promise;
  }
  const promise = (async () => {
    const data = await ipc.readBackdropImage(normalized);
    const bytes = decodeBase64(data.dataBase64);
    const blob = new Blob([bytes], { type: data.mime });
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return `data:${data.mime};base64,${data.dataBase64}`;
    }
    const url = URL.createObjectURL(blob);
    if (activeObjectUrl && activeObjectUrl !== url) {
      revokeObjectUrlSafe(activeObjectUrl);
    }
    activeObjectUrl = url;
    return url;
  })();
  promise.catch(() => {});
  cachedImageLoad = { path: normalized, promise };
  return promise;
}

const BACKDROP_ERROR_KEYS: Record<string, string> = {
  "backdrop.err.read_failed": "settings.chatBackdropErrRead",
  "backdrop.err.too_large": "settings.chatBackdropErrTooLarge",
  "backdrop.err.unsupported": "settings.chatBackdropErrUnsupported",
};

export function backdropErrorMessage(error: unknown, t: TFunction): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  for (const [code, key] of Object.entries(BACKDROP_ERROR_KEYS)) {
    if (raw.includes(code)) return t(key);
  }
  return t("settings.chatBackdropErrRead");
}
