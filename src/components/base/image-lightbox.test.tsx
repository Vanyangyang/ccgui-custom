import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "@/lib/i18n";
import i18n from "@/lib/i18n";

import { ImageLightbox } from "./image-lightbox";

// jsdom has no dialog modal support; the lightbox calls showModal on mount.
HTMLDialogElement.prototype.showModal = vi.fn();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// 192000 bytes → "187.5 KB", the reference screenshot's value.
const bytes = Array.from({ length: 192000 }, (_, i) => i % 256);
const SRC = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  act(() => {
    root.render(<ImageLightbox src={SRC} name="douyin.png" onClose={onClose} />);
  });
  return { container, root, onClose };
}

describe("ImageLightbox", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: Mock;

  beforeEach(async () => {
    // The app defaults to zh; assert against the English labels.
    await i18n.changeLanguage("en");
    ({ container, root, onClose } = render());
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const dialog = () => container.querySelector("dialog")!;
  const img = () => container.querySelector("img")!;
  const zoomLabel = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.endsWith("%"),
    )!;

  it("shows name, dimensions and file size in the header", async () => {
    Object.defineProperties(img(), {
      naturalWidth: { value: 792, configurable: true },
      naturalHeight: { value: 964, configurable: true },
    });
    await act(async () => {
      img().dispatchEvent(new Event("load"));
    });
    expect(container.textContent).toContain("douyin.png");
    expect(container.textContent).toContain("792 × 964 · 187.5 KB");
  });

  it("zooms in via toolbar and resets to fit via the percent button", async () => {
    expect(zoomLabel().textContent).toBe("100%");
    const zoomIn = container.querySelector('button[aria-label="Zoom in"]')!;
    await act(async () => {
      zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(zoomLabel().textContent).toBe("125%");
    expect(img().style.transform).toContain("scale(1.25)");
    await act(async () => {
      zoomLabel().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(zoomLabel().textContent).toBe("100%");
    expect(img().style.transform).toContain("scale(1)");
  });

  it("zooms with the mouse wheel without closing", async () => {
    await act(async () => {
      dialog().dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(Number(zoomLabel().textContent!.replace("%", ""))).toBeGreaterThan(100);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on × and on backdrop press, not on toolbar presses", async () => {
    const close = container.querySelector('button[aria-label="Close preview"]')!;
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      zoomLabel().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
