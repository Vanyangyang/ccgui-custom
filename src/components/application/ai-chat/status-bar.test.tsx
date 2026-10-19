import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { StatusBar } from "./ai-chat-composer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("status bar context capacity", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("labels known capacity without a false occupancy ring or percentage", async () => {
    await act(async () => root.render(<StatusBar contextMax={1_000_000} contextMaxKnown contextOccupancyKnown={false} contextShowCapacity />));
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe("Context window1M");
    expect(trigger.querySelector("svg")).toBeNull();
    expect(trigger.textContent).not.toContain("%");
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1M");
  });

  it("does not expose an assumed window as measured capacity", async () => {
    await act(async () => root.render(<StatusBar contextMax={200_000} contextMaxKnown={false} contextOccupancyKnown={false} contextShowCapacity />));
    expect(container.textContent).toBe("Context windowUnknown");
    expect(container.textContent).not.toContain("200");
  });
});
