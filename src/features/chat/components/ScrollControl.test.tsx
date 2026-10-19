import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollControl } from "./ScrollControl";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

/** Mirrors the component's HIDE_DELAY_MS. */
const HIDE_DELAY_MS = 1500;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** jsdom reports no scroll geometry; a mutable mirror stands in, with the
 *  browser's clamp semantics on scrollTop. */
function makeScrollable({
  scrollHeight = 2000,
  clientHeight = 500,
  scrollTop = 300,
} = {}) {
  const el = document.createElement("div");
  const geometry = { scrollHeight, clientHeight, scrollTop };
  Object.defineProperties(el, {
    scrollHeight: { get: () => geometry.scrollHeight, configurable: true },
    clientHeight: { value: clientHeight, configurable: true },
    scrollTop: {
      get: () => geometry.scrollTop,
      set: (value: number) => {
        geometry.scrollTop = Math.max(
          0,
          Math.min(value, geometry.scrollHeight - geometry.clientHeight),
        );
      },
      configurable: true,
    },
  });
  container.appendChild(el);
  const onJump = vi.fn();
  act(() => {
    root.render(<ScrollControl scrollRef={{ current: el }} onJump={onJump} />);
  });
  return { el, geometry, onJump };
}

function wheel(el: HTMLElement, deltaY: number) {
  act(() => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  });
}

function control() {
  return container.querySelector<HTMLButtonElement>("button");
}

describe("ScrollControl", () => {
  it("stays hidden until the user wheels", () => {
    makeScrollable();
    expect(control()).toBeNull();
  });

  it("shows the back-to-top arrow on wheel up and reports the top edge", () => {
    const { el, onJump } = makeScrollable({ scrollTop: 300 });

    wheel(el, -120);

    const button = control();
    expect(button?.getAttribute("aria-label")).toBe("chat.backToTop");
    act(() => button!.click());
    expect(onJump).toHaveBeenCalledWith("top");
    expect(control()).toBeNull();
  });

  it("shows the back-to-bottom arrow on wheel down and reports the bottom edge", () => {
    const { el, onJump } = makeScrollable({ scrollTop: 300 });

    wheel(el, 120);

    const button = control();
    expect(button?.getAttribute("aria-label")).toBe("chat.backToBottom");
    act(() => button!.click());
    expect(onJump).toHaveBeenCalledWith("bottom");
    expect(control()).toBeNull();
  });

  it("stays hidden when the tail is within the threshold, even on wheel down", () => {
    const { el } = makeScrollable({ scrollTop: 1500 });

    wheel(el, 120);

    expect(control()).toBeNull();
  });

  it("stays hidden when the content does not overflow the viewport", () => {
    const { el } = makeScrollable({ scrollHeight: 400, clientHeight: 500, scrollTop: 0 });

    wheel(el, -120);

    expect(control()).toBeNull();
  });

  it("retires itself after the wheel goes idle", () => {
    vi.useFakeTimers();
    const { el } = makeScrollable({ scrollTop: 300 });

    wheel(el, -120);
    expect(control()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(HIDE_DELAY_MS);
    });
    expect(control()).toBeNull();
  });
});
