import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineSearchBar } from "./TimelineSearchBar";

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

// i18next is initialized app-side; the bar only needs t() passthrough here.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("TimelineSearchBar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let inputRef: { current: HTMLInputElement | null };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    inputRef = { current: null };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderBar(props: {
    query?: string;
    total?: number;
    current?: number;
    onQueryChange?: (value: string) => void;
    onPrev?: () => void;
    onNext?: () => void;
    onClose?: () => void;
  }) {
    await act(async () => {
      root.render(
        <TimelineSearchBar
          query={props.query ?? ""}
          onQueryChange={props.onQueryChange ?? (() => {})}
          current={props.current ?? 0}
          total={props.total ?? 0}
          onPrev={props.onPrev ?? (() => {})}
          onNext={props.onNext ?? (() => {})}
          onClose={props.onClose ?? (() => {})}
          inputRef={inputRef}
        />,
      );
    });
  }

  function keydown(target: Element, key: string, shiftKey = false) {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
    );
  }

  it("shows the match position and total", async () => {
    await renderBar({ query: "bug", total: 12, current: 2 });
    expect(container.textContent).toContain("3/12");
  });

  it("shows the no-results label for a query without matches", async () => {
    await renderBar({ query: "zzz", total: 0 });
    expect(container.textContent).toContain("chat.searchNoResults");
  });

  it("keeps the counter blank before any query", async () => {
    await renderBar({ query: "", total: 0 });
    expect(container.textContent).not.toContain("chat.searchNoResults");
  });

  it("Enter goes to the next match, Shift+Enter to the previous", async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    await renderBar({ query: "bug", total: 3, onNext, onPrev });
    const input = container.querySelector("input")!;
    keydown(input, "Enter");
    keydown(input, "Enter", true);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the bar", async () => {
    const onClose = vi.fn();
    await renderBar({ query: "bug", total: 3, onClose });
    keydown(container.querySelector("input")!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("typing reports the new query", async () => {
    const onQueryChange = vi.fn();
    await renderBar({ onQueryChange });
    const input = container.querySelector("input")!;
    // React tracks input values through its own descriptor; go through the
    // native prototype setter so its onChange actually fires.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, "矩阵");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onQueryChange).toHaveBeenCalledWith("矩阵");
  });
});
