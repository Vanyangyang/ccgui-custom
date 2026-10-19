import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InfoTip } from "./tooltip";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("InfoTip", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container.remove();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root!.render(<InfoTip label="hint copy" />);
    });
    return container.querySelector("button")!;
  }

  const tipVisible = () =>
    !!document.querySelector('[data-slot="tooltip"], [role="tooltip"]') ||
    [...document.querySelectorAll("body *")].some((el) => el.textContent === "hint copy");

  it("click pins the tip open; outside press closes it", async () => {
    const button = await render();
    expect(tipVisible()).toBe(false);

    await act(async () => button.click());
    expect(tipVisible()).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(tipVisible()).toBe(false);
  });

  it("second click closes the pinned tip", async () => {
    const button = await render();
    await act(async () => button.click());
    expect(tipVisible()).toBe(true);

    await act(async () => button.click());
    expect(tipVisible()).toBe(false);
  });

  it("Escape closes the pinned tip", async () => {
    const button = await render();
    await act(async () => button.click());
    expect(tipVisible()).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(tipVisible()).toBe(false);
  });
  it("scroll unpins the tip", async () => {
    const button = await render();
    await act(async () => button.click());
    expect(tipVisible()).toBe(true);

    await act(async () => {
      document.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    expect(tipVisible()).toBe(false);
  });
});
