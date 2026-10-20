import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "@/lib/i18n";
import i18n from "@/lib/i18n";

import { ipc } from "@/lib/ipc";
import { ImageLightbox } from "./image-lightbox";

const platform = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, get isWeb() { return platform.web; } };
});

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

  it("offers no annotate toggle without an annotation target", () => {
    expect(container.querySelector('button[aria-label="Annotate image"]')).toBeNull();
  });
});

describe("ImageLightbox annotation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: Mock;
  let onSubmit: Mock;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
    onSubmit = vi.fn(async () => {});
    act(() => {
      root.render(<ImageLightbox src={SRC} name="ui.png" onClose={onClose} annotation={{ onSubmit }} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const textButton = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text)!;
  const surface = () => container.querySelector<HTMLDivElement>("[data-annotation-surface]")!;

  async function startAnnotating() {
    await act(async () => button("Annotate image").click());
    // The overlay sits on a 200×100 image at the viewport origin.
    surface().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
  }
  async function drawBox(from: [number, number], to: [number, number]) {
    const fire = (type: string, [clientX, clientY]: [number, number]) =>
      surface().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
    await act(async () => fire("pointerdown", from));
    await act(async () => fire("pointermove", to));
    await act(async () => fire("pointerup", to));
  }
  async function typeNote(index: number, value: string) {
    const field = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="Note ${index}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("draws numbered boxes, requires notes and submits image fractions", async () => {
    await startAnnotating();
    await drawBox([20, 30], [100, 80]);
    await drawBox([150, 10], [151, 11]); // click-sized: ignored
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(textButton("Add to draft").disabled).toBe(true);
    await typeNote(1, "Label is clipped");
    expect(textButton("Add to draft").disabled).toBe(false);
    await act(async () => textButton("Add to draft").click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [boxes] = onSubmit.mock.calls[0];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ note: "Label is clipped" });
    expect(boxes[0].x).toBeCloseTo(0.1);
    expect(boxes[0].y).toBeCloseTo(0.3);
    expect(boxes[0].width).toBeCloseTo(0.4);
    expect(boxes[0].height).toBeCloseTo(0.5);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never closes on stray presses and confirms before discarding notes", async () => {
    await startAnnotating();
    await drawBox([20, 30], [100, 80]);
    await act(async () => {
      container.querySelector("dialog")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const escape = new Event("cancel", { cancelable: true });
    await act(async () => container.querySelector("dialog")!.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(container.textContent).toContain("Discard 1 notes?");
    await act(async () => textButton("Keep editing").click());
    expect(container.querySelectorAll("textarea")).toHaveLength(1);

    await act(async () => button("Close preview").click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => textButton("Discard").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the notes and shows the error when submitting fails", async () => {
    onSubmit.mockRejectedValueOnce(new Error("attachment too large"));
    await startAnnotating();
    await drawBox([20, 30], [100, 80]);
    await typeNote(1, "Wrong color");
    await act(async () => textButton("Add to draft").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("attachment too large");
    expect(container.querySelector("textarea")!.value).toBe("Wrong color");
  });
});

describe("ImageLightbox gallery and actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const OTHER = "data:image/png;base64,iVBORw0KGgo=";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const img = () => container.querySelector("img")!;
  const key = (k: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      container.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
    });

  function Gallery({ sources, start = 0, annotate = false }: { sources: string[]; start?: number; annotate?: boolean }) {
    const [index, setIndex] = useState(start);
    return (
      <ImageLightbox
        src={sources[index]}
        name={`image-${index + 1}.png`}
        onClose={() => {}}
        annotation={annotate ? { onSubmit: async () => {} } : undefined}
        nav={{ index, count: sources.length, onPrev: () => setIndex((i) => i - 1), onNext: () => setIndex((i) => i + 1) }}
      />
    );
  }

  it("steps with side buttons and arrow keys, stopping at both ends", async () => {
    act(() => root.render(<Gallery sources={[SRC, OTHER, SRC]} />));
    expect(container.textContent).toContain("1 / 3");
    expect(button("Previous image")!.disabled).toBe(true);
    await act(async () => button("Next image")!.click());
    expect(container.textContent).toContain("2 / 3");
    expect(img().getAttribute("src")).toBe(OTHER);
    await key("ArrowRight");
    expect(container.textContent).toContain("3 / 3");
    expect(button("Next image")!.disabled).toBe(true);
    await key("ArrowDown");
    expect(container.textContent).toContain("3 / 3");
    await key("ArrowUp");
    await key("ArrowLeft", { ctrlKey: true });
    expect(container.textContent).toContain("2 / 3");
    await key("PageUp");
    expect(container.textContent).toContain("1 / 3");
  });

  it("opens each image at fit and unrotated", async () => {
    act(() => root.render(<Gallery sources={[SRC, OTHER]} />));
    await act(async () => button("Zoom in")!.click());
    await act(async () => button("Rotate 90°")!.click());
    expect(img().style.transform).toContain("rotate(90deg)");
    expect(img().style.maxWidth).toBe("100vh");
    await key("ArrowRight");
    expect(img().style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(img().style.maxWidth).toBe("");
  });

  it("locks the gallery and rotation while annotating", async () => {
    act(() => root.render(<Gallery sources={[SRC, OTHER]} annotate />));
    await act(async () => button("Rotate 90°")!.click());
    await act(async () => button("Annotate image")!.click());
    expect(img().style.transform).not.toContain("rotate");
    expect(button("Next image")!.disabled).toBe(true);
    expect(button("Rotate 90°")!.disabled).toBe(true);
    await key("ArrowRight");
    expect(img().getAttribute("src")).toBe(SRC);
  });

  it("1:1 scales the fitted box up to the natural size", async () => {
    act(() => root.render(<ImageLightbox src={SRC} name="big.png" onClose={() => {}} />));
    Object.defineProperties(img(), {
      naturalWidth: { value: 2000, configurable: true },
      naturalHeight: { value: 1000, configurable: true },
      offsetWidth: { value: 1000, configurable: true },
    });
    await act(async () => img().dispatchEvent(new Event("load")));
    await act(async () => button("Actual size (1:1)")!.click());
    expect(img().style.transform).toContain("scale(2)");
  });

  it("saves, copies the path and reveals file-backed images with feedback", async () => {
    const save = vi.spyOn(ipc, "saveImageAs").mockResolvedValueOnce("D:/saved.png").mockResolvedValueOnce(null);
    const reveal = vi.spyOn(ipc, "revealInFileManager").mockRejectedValue(new Error("gone"));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    act(() => root.render(<ImageLightbox src={SRC} name="art.png" sourcePath="C:/out/art.png" onClose={() => {}} />));

    await act(async () => button("Save as…")!.click());
    // A file-backed image is copied by the backend, not re-sent as a payload.
    expect(save).toHaveBeenCalledWith("art.png", { sourcePath: "C:/out/art.png" });
    expect(button("Saved")).not.toBeNull();
    await act(async () => button("Saved")!.click());
    // A cancelled dialog reports nothing.
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => button("Copy file path")!.click());
    expect(writeText).toHaveBeenCalledWith("C:/out/art.png");
    expect(button("Copied")).not.toBeNull();

    await act(async () => button("Show in folder")!.click());
    expect(reveal).toHaveBeenCalledWith("C:/out/art.png");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("gone");
  });

  it("copies an object-URL image from its bytes and saves data URLs as payloads", async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    const items: unknown[] = [];
    vi.stubGlobal("ClipboardItem", class { constructor(item: unknown) { items.push(item); } });
    const blob = new Blob([new Uint8Array(12 * 1024 * 1024)], { type: "image/png" });
    act(() => root.render(<ImageLightbox src="blob:http://tauri.localhost/1" name="render.png" sourcePath="G:/w/render.png"
      sizeBytes={blob.size} imageBlob={blob} onClose={() => {}} />));
    Object.defineProperties(img(), {
      naturalWidth: { value: 3840, configurable: true },
      naturalHeight: { value: 2160, configurable: true },
    });
    await act(async () => img().dispatchEvent(new Event("load")));
    expect(container.textContent).toContain("3840 × 2160 · 12.0 MB");
    await act(async () => button("Copy image")!.click());
    expect(items).toEqual([{ "image/png": blob }]);
    expect(button("Copied")).not.toBeNull();

    const save = vi.spyOn(ipc, "saveImageAs").mockResolvedValue("D:/a.png");
    act(() => root.render(<ImageLightbox src={SRC} name="a.png" onClose={() => {}} />));
    await act(async () => button("Save as…")!.click());
    expect(save).toHaveBeenCalledWith("a.png", { dataUrl: SRC });
    vi.unstubAllGlobals();
  });

  it("reports a failed image copy and offers no path actions without a file", async () => {
    Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
    act(() => root.render(<ImageLightbox src={SRC} name="art.png" onClose={() => {}} />));
    expect(button("Copy file path")).toBeNull();
    expect(button("Show in folder")).toBeNull();
    await act(async () => button("Copy image")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Copy failed");
  });

  it("downloads in the browser and never reveals host folders on web", async () => {
    platform.web = true;
    try {
      const save = vi.spyOn(ipc, "saveImageAs");
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      act(() => root.render(<ImageLightbox src={SRC} name="art.png" sourcePath="C:/out/art.png" onClose={() => {}} />));
      expect(button("Show in folder")).toBeNull();
      await act(async () => button("Download image")!.click());
      expect(click).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      expect(button("Download started")).not.toBeNull();
    } finally {
      platform.web = false;
    }
  });

  it("shows loading and unavailable states without an image", () => {
    act(() => root.render(<ImageLightbox src={null} name="next.png" onClose={() => {}} />));
    expect(container.querySelector("img")).toBeNull();
    expect(button("Copy image")!.disabled).toBe(true);
    act(() => root.render(<ImageLightbox src={null} unavailable name="next.png" onClose={() => {}} />));
    expect(container.textContent).toContain("Image unavailable");
  });
});
