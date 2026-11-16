// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readBackdropImageMock, setWindowThemeMock, listenMock } = vi.hoisted(() => ({
  readBackdropImageMock: vi.fn(),
  setWindowThemeMock: vi.fn(async () => {}),
  listenMock: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    readBackdropImage: readBackdropImageMock,
    setWindowTheme: setWindowThemeMock,
    getAppSettings: vi.fn(async () => ({})),
    refreshAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/transport", () => ({
  isWeb: false,
  listen: listenMock,
}));

import {
  applyBackdropPreferences,
  applyBackdropRecipe,
  CHAT_BACKDROP_RECIPES,
  CHAT_BACKDROP_STORAGE_KEY,
  corridorAttenuation,
  DEFAULT_CHAT_BACKDROP,
  effectiveBackdropPreset,
  matchesBackdropRecipe,
  normalizeChatBackdrop,
  readCachedBackdropPreferences,
  resolveBackdropRgb,
} from "./backdrop";
import { bindCachedAppearanceSync } from "./theme";
import { ConversationBackdrop } from "@/features/chat/components/ConversationBackdrop";

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

function mockViewportRect() {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: 1200,
        height: 720,
        top: 0,
        left: 0,
        right: 1200,
        bottom: 720,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

describe("chat backdrop config, contrast safety, and renderer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.accent;
    applyBackdropPreferences(DEFAULT_CHAT_BACKDROP, false);
    readBackdropImageMock.mockReset();
    host = document.createElement("div");
    host.style.width = "1200px";
    host.style.height = "720px";
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    applyBackdropPreferences(DEFAULT_CHAT_BACKDROP, false);
    vi.restoreAllMocks();
  });

  it("normalizes out-of-range values, invalid enums, parallax flag, and custom image paths", () => {
    const normalized = normalizeChatBackdrop({
      preset: " BAYER-DITHER ",
      opacity: 2,
      speed: 250,
      scale: -10,
      scrim: 37.6,
      colorMode: "CUSTOM",
      customColor: " #AABBCC ",
      imageFile: "G:/bg/bad\0.png",
      blur: 99,
      fit: "REPEAT",
      parallax: false,
    });
    expect(normalized).toEqual({
      preset: "bayer-dither",
      opacity: 10,
      speed: 150,
      scale: 20,
      scrim: 38,
      colorMode: "custom",
      customColor: "#aabbcc",
      imageFile: "",
      blur: 24,
      fit: "repeat",
      parallax: false,
    });

    const fallback = normalizeChatBackdrop({
      preset: "unknown-preset",
      colorMode: "rainbow",
      customColor: "not-hex",
      imageFile: " D:/wallpapers/tech.webp ",
      fit: "stretch",
    });
    expect(fallback.preset).toBe("pixel-wave");
    expect(fallback.colorMode).toBe("accent");
    expect(fallback.customColor).toBe("#06b6d4");
    expect(fallback.imageFile).toBe("D:/wallpapers/tech.webp");
    expect(fallback.fit).toBe("cover");
    expect(fallback.parallax).toBe(true);

    expect(
      effectiveBackdropPreset({ ...DEFAULT_CHAT_BACKDROP, preset: "custom-image" }, true),
    ).toBe("pixel-wave");
  });

  it("applies and matches mood recipes while clearing highlight on manual edits", () => {
    for (const recipe of CHAT_BACKDROP_RECIPES) {
      const base = { ...DEFAULT_CHAT_BACKDROP, customColor: "#ff00aa", opacity: 90 };
      const applied = applyBackdropRecipe(base, recipe);
      expect(matchesBackdropRecipe(applied, recipe)).toBe(true);

      const tweaked = normalizeChatBackdrop({ ...applied, opacity: applied.opacity + 1 });
      expect(matchesBackdropRecipe(tweaked, recipe)).toBe(false);
    }
  });

  it("clamps extreme DIY colors to protect light/dark foreground text contrast", () => {
    const pureBlack = {
      ...DEFAULT_CHAT_BACKDROP,
      colorMode: "custom",
      customColor: "#000000",
    };
    const pureWhite = {
      ...DEFAULT_CHAT_BACKDROP,
      colorMode: "custom",
      customColor: "#ffffff",
    };

    const lightBlack = resolveBackdropRgb(pureBlack, "blue", false).primary;
    const lightWhite = resolveBackdropRgb(pureWhite, "blue", false).primary;
    expect(lightBlack[0]).toBeGreaterThanOrEqual(90);
    expect(lightWhite[0]).toBeLessThanOrEqual(150);

    const darkBlack = resolveBackdropRgb(pureBlack, "blue", true).primary;
    const darkWhite = resolveBackdropRgb(pureWhite, "blue", true).primary;
    expect(darkBlack[0]).toBeGreaterThanOrEqual(125);
    expect(darkWhite[0]).toBeLessThanOrEqual(202);

    const violetLight = resolveBackdropRgb(DEFAULT_CHAT_BACKDROP, "violet", false);
    const tealLight = resolveBackdropRgb(DEFAULT_CHAT_BACKDROP, "teal", false);
    expect(violetLight.primary).not.toEqual(tealLight.primary);
  });

  it("attenuates particles inside the reading corridor while keeping wings vibrant", () => {
    expect(corridorAttenuation(700, 1400, 0)).toBe(1);
    expect(corridorAttenuation(60, 1400, 0)).toBe(1);

    const center = corridorAttenuation(700, 1400, 78, false);
    const midEdge = corridorAttenuation(1150, 1400, 78, false);
    const wing = corridorAttenuation(60, 1400, 78, false);
    expect(center).toBeCloseTo(1 - 0.78 * 0.88, 3);
    expect(midEdge).toBeGreaterThan(center);
    expect(wing).toBe(1);
  });

  it("persists to localStorage and syncs via cross-window storage events", () => {
    applyBackdropPreferences({
      ...DEFAULT_CHAT_BACKDROP,
      preset: "komorebi",
      opacity: 64,
      parallax: false,
    });
    expect(readCachedBackdropPreferences().preset).toBe("komorebi");
    expect(readCachedBackdropPreferences().opacity).toBe(64);
    expect(readCachedBackdropPreferences().parallax).toBe(false);

    const stop = bindCachedAppearanceSync();
    window.localStorage.setItem(
      CHAT_BACKDROP_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_CHAT_BACKDROP, preset: "aurora-mesh", scrim: 90 }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CHAT_BACKDROP_STORAGE_KEY,
      }),
    );
    expect(readCachedBackdropPreferences().preset).toBe("aurora-mesh");
    stop();
  });

  it("renders all 10 procedural presets, returns null for none, and adds image veils", async () => {
    const mockCtx = createMockContext2D();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => mockCtx as unknown as RenderingContext,
    );
    mockViewportRect();
    const rafMock = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const cafMock = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    for (const preset of [
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
    ] as const) {
      await act(async () => {
        applyBackdropPreferences({ ...DEFAULT_CHAT_BACKDROP, preset, speed: 50 }, false);
        root.render(createElement(ConversationBackdrop, { preview: true }));
      });
      const layer = host.querySelector(`[data-conversation-backdrop="${preset}"]`);
      expect(layer).not.toBeNull();
    }
    expect(vi.mocked(mockCtx.fillRect).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(mockCtx.fill).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(mockCtx.stroke).mock.calls.length).toBeGreaterThan(0);
    expect(rafMock).toHaveBeenCalled();

    await act(async () => {
      applyBackdropPreferences({ ...DEFAULT_CHAT_BACKDROP, preset: "none" }, false);
      root.render(createElement(ConversationBackdrop));
    });
    expect(host.querySelector("[data-conversation-backdrop]")).toBeNull();
    expect(cafMock).toHaveBeenCalled();

    readBackdropImageMock.mockResolvedValueOnce({
      mime: "image/png",
      dataBase64: "iVBORw0KGgo=",
    });
    const origCreateUrl = URL.createObjectURL;
    const origRevokeUrl = URL.revokeObjectURL;
    const createUrlMock = vi.fn(() => "blob:mock-wallpaper");
    const revokeUrlMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createUrlMock });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeUrlMock });
    try {
      await act(async () => {
        applyBackdropPreferences(
          {
            ...DEFAULT_CHAT_BACKDROP,
            preset: "custom-image",
            imageFile: "G:/wallpapers/bg.png",
            blur: 10,
          },
          false,
        );
        root.render(createElement(ConversationBackdrop));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(createUrlMock).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-backdrop-layer="custom-image"]')).not.toBeNull();
      expect(host.querySelector('[data-backdrop-layer="image-polarity-veil"]')).not.toBeNull();
      expect(host.querySelector('[data-backdrop-layer="corridor-veil"]')).not.toBeNull();
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: origCreateUrl });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: origRevokeUrl });
    }
  });

  it("coalesces timeline scroll parallax in static mode and ignores nested code scrolls", async () => {
    const mockCtx = createMockContext2D();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => mockCtx as unknown as RenderingContext,
    );
    mockViewportRect();
    let queuedTick: FrameRequestCallback | null = null;
    const rafMock = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queuedTick = cb;
      return 77;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    await act(async () => {
      applyBackdropPreferences(
        { ...DEFAULT_CHAT_BACKDROP, preset: "pixel-wave", speed: 0, parallax: true },
        false,
      );
      root.render(
        createElement(
          "div",
          null,
          createElement(ConversationBackdrop),
          createElement("div", { "data-backdrop-scroll-source": "", "data-testid": "timeline-scroller" }),
          createElement("pre", { "data-testid": "code-scroller" }),
        ),
      );
    });

    // Static mount draws 1 frame synchronously without starting an idle rAF loop.
    expect(rafMock).not.toHaveBeenCalled();

    const codeScroller = host.querySelector('[data-testid="code-scroller"]') as HTMLElement;
    const timelineScroller = host.querySelector('[data-testid="timeline-scroller"]') as HTMLElement;

    codeScroller.scrollTop = 120;
    codeScroller.dispatchEvent(new Event("scroll"));
    expect(rafMock).not.toHaveBeenCalled();

    const clearCallsBefore = vi.mocked(mockCtx.clearRect).mock.calls.length;
    timelineScroller.scrollTop = 480;
    timelineScroller.dispatchEvent(new Event("scroll"));
    expect(rafMock).toHaveBeenCalledTimes(1);

    // Run queued rAF far enough past 32ms ceiling; it repaints once and stops.
    expect(queuedTick).not.toBeNull();
    queuedTick!(performance.now() + 80);
    expect(vi.mocked(mockCtx.clearRect).mock.calls.length).toBeGreaterThan(clearCallsBefore);
    expect(rafMock).toHaveBeenCalledTimes(1);

    // Disabling parallax stops scroll-triggered redraws.
    rafMock.mockClear();
    await act(async () => {
      applyBackdropPreferences(
        { ...DEFAULT_CHAT_BACKDROP, preset: "pixel-wave", speed: 0, parallax: false },
        false,
      );
    });
    timelineScroller.scrollTop = 900;
    timelineScroller.dispatchEvent(new Event("scroll"));
    expect(rafMock).not.toHaveBeenCalled();
  });
});
