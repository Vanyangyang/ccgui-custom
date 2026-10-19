import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDECHAT_WIDTH_KEY, useSidechatResize } from "./use-sidechat-resize";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ open = true, session = "a" }: { open?: boolean; session?: string }) {
  const { panelRef, handleRef } = useSidechatResize(open, session);
  return <main>{open && <aside ref={panelRef}><div ref={handleRef} role="separator" tabIndex={0} /></aside>}</main>;
}

describe("Sidechat horizontal resize", () => {
  let container: HTMLDivElement;
  let root: Root;
  let available: number;
  let resize: () => void;
  let disconnect: ReturnType<typeof vi.fn>;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let desktop: boolean;
  let mediaChange: () => void;
  const render = (open = true, session = "a") => act(async () => root.render(<Probe open={open} session={session} />));
  const handle = () => container.querySelector('[role="separator"]') as HTMLDivElement;
  const width = () => Number(handle().getAttribute("aria-valuenow"));
  const pointer = (target: EventTarget, type: string, x: number, id = 1) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperty(event, "pointerId", { value: id });
    target.dispatchEvent(event);
  };
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const key = (value: string) => handle().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  beforeEach(() => {
    localStorage.clear();
    available = 1200;
    desktop = true;
    frames = new Map(); nextFrame = 0;
    disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("matchMedia", () => ({ get matches() { return desktop; }, addEventListener: (_event: string, callback: () => void) => { mediaChange = callback; }, removeEventListener: vi.fn() }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: available } as DOMRect));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("drags in both directions, clamps, and restores a saved width when reopened", async () => {
    await render(); expect(width()).toBe(416);
    pointer(handle(), "pointerdown", 800);
    pointer(window, "pointermove", 700); flush(); expect(width()).toBe(516);
    pointer(window, "pointermove", 900); flush(); expect(width()).toBe(316);
    pointer(window, "pointerup", 900); expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("316");
    await render(false); await render(); expect(width()).toBe(316);
    pointer(handle(), "pointerdown", 800); pointer(window, "pointerup", 0); expect(width()).toBe(720);
    pointer(handle(), "pointerdown", 800); pointer(window, "pointerup", 2000); expect(width()).toBe(280);
  });

  it("supports keyboard bounds and recovers preferred width after parent constraints change", async () => {
    await render();
    key("ArrowLeft"); expect(width()).toBe(432);
    key("ArrowRight"); expect(width()).toBe(416);
    key("Home"); expect(width()).toBe(280);
    key("End"); expect(width()).toBe(720);
    available = 700; resize(); expect(width()).toBe(420);
    available = 400; resize(); expect(width()).toBe(200);
    expect(handle().getAttribute("aria-valuemin")).toBe("200");
    available = 1200; resize(); expect(width()).toBe(720);
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("720");
  });

  it.each(["pointercancel", "blur"])("cancels pending frames on %s without persisting", async (event) => {
    await render(); pointer(handle(), "pointerdown", 800);
    pointer(window, "pointermove", 600); flush(); expect(width()).toBe(616);
    pointer(window, "pointermove", 550);
    pointer(window, event, 550); flush(); expect(width()).toBe(416);
    pointer(window, "pointerup", 500); expect(width()).toBe(416);
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("preserves dragging on same-width observations but cancels for width or desktop changes", async () => {
    await render();
    pointer(handle(), "pointerdown", 800);
    pointer(window, "pointermove", 700);
    // ResizeObserver also fires for height-only changes and its initial observation.
    resize(); flush(); expect(width()).toBe(516);
    resize(); expect(width()).toBe(516);
    pointer(window, "pointerup", 650); expect(width()).toBe(566);
    pointer(handle(), "pointerdown", 800);
    pointer(window, "pointermove", 700); flush(); expect(width()).toBe(666);
    available = 700; resize(); expect(width()).toBe(420);
    pointer(window, "pointerup", 600);
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("566");
    available = 1200; resize(); expect(width()).toBe(566);
    pointer(handle(), "pointerdown", 800);
    pointer(window, "pointermove", 700); flush(); expect(width()).toBe(666);
    desktop = false; mediaChange(); expect(width()).toBe(566);
    pointer(window, "pointerup", 600);
    desktop = true; mediaChange(); expect(width()).toBe(566);
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("566");
    expect(frames.size).toBe(0);
  });

  it("cleans up when closed, switched to another session, or unmounted mid-drag", async () => {
    await render(); pointer(handle(), "pointerdown", 800); pointer(window, "pointermove", 600);
    await render(true, "b"); flush(); pointer(window, "pointerup", 600); expect(width()).toBe(416);
    pointer(handle(), "pointerdown", 800); pointer(window, "pointermove", 600);
    await render(false, "b"); flush(); pointer(window, "pointerup", 600);
    await render(); expect(width()).toBe(416);
    pointer(handle(), "pointerdown", 800); pointer(window, "pointermove", 600);
    await act(async () => root.render(null)); flush(); pointer(window, "pointerup", 600);
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBeNull();
    expect(frames.size).toBe(0); expect(disconnect).toHaveBeenCalledTimes(3);
  });

  it.each(["oops", "null", "100", "721", "\"500\"", "1e999"])("rejects invalid persisted width %s", async (stored) => {
    localStorage.setItem(SIDECHAT_WIDTH_KEY, stored); await render(); expect(width()).toBe(416);
  });

  it("ignores other pointers and desktop resize events while stacked on mobile", async () => {
    await render(); pointer(handle(), "pointerdown", 800); pointer(window, "pointerup", 600, 2);
    expect(width()).toBe(416); pointer(window, "pointercancel", 800);
    desktop = false;
    pointer(handle(), "pointerdown", 800); pointer(window, "pointerup", 600); key("End");
    expect(width()).toBe(416); expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBeNull();
  });
});
