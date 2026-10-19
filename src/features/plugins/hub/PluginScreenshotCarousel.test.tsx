import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { PluginScreenshotCarousel } from "./PluginScreenshotCarousel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHOTS = [
  "https://cdn.example.com/shot-1.png",
  "https://cdn.example.com/shot-2.png",
];

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

describe("PluginScreenshotCarousel", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  async function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    return container;
  }

  async function openLightbox(view: HTMLElement) {
    await act(async () => {
      buttonByLabel(view, i18n.t("plugins.hub.screenshotZoom")).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(dialog()).not.toBeNull();
  }

  /** Backdrop press. react-aria pairs pointerdown + click when PointerEvent
   *  exists and mousedown + mouseup otherwise (the jsdom path); dispatching
   *  both pairs keeps this independent of the environment. */
  async function pressBackdrop() {
    const overlay = dialog()!.parentElement!.parentElement!;
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        overlay.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    });
  }

  it("closes the zoomed screenshot from the X", async () => {
    const view = await render(<PluginScreenshotCarousel images={SHOTS} name="React Doctor" />);
    await openLightbox(view);

    const close = buttonByLabel(document.body, i18n.t("plugins.hub.screenshotClose"));
    expect(close.getAttribute("title")).toBe(i18n.t("plugins.hub.screenshotClose"));
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("closes the zoomed screenshot on a backdrop press", async () => {
    const view = await render(<PluginScreenshotCarousel images={SHOTS} name="React Doctor" />);
    await openLightbox(view);

    await pressBackdrop();
    expect(dialog()).toBeNull();
  });

  it("closes the zoomed screenshot on Escape", async () => {
    const view = await render(<PluginScreenshotCarousel images={SHOTS} name="React Doctor" />);
    await openLightbox(view);

    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
  });
});
