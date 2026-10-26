import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { StatusBar } from "./ai-chat-composer";
import { cacheHeatRingStroke, cacheHeatTextColor } from "@/features/chat/session-cleanup";

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

  it("shows permanent-cache color without an expiry state or cold-cache handoff", async () => {
    await act(async () => root.render(<StatusBar contextMax={100_000} contextMaxKnown contextOccupancyKnown
      usagePct={50} cacheHeatRatio={1} cacheNote={i18n.t("chat.cachePermanent")} onArchiveAndHandoff={() => {}} />));
    const trigger = container.querySelector("button")!;
    expect(trigger.dataset.cacheHeatRatio).toBe("1");
    expect(trigger.querySelector('circle[stroke-linecap="round"]')?.getAttribute("stroke")).toBe(cacheHeatRingStroke(1));
    expect([...trigger.querySelectorAll("span")].some((span) => span.style.color === cacheHeatTextColor(1))).toBe(true);
    await act(async () => trigger.click());
    const text = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(text).toContain(i18n.t("chat.cachePermanent"));
    expect(text).not.toContain(i18n.t("chat.cacheColdHandoffHint"));
  });

  it("does not expose an assumed window as measured capacity", async () => {
    await act(async () => root.render(<StatusBar contextMax={200_000} contextMaxKnown={false} contextOccupancyKnown={false} contextShowCapacity />));
    expect(container.textContent).toBe("Context windowUnknown");
    expect(container.textContent).not.toContain("200");
  });

  it("displays measured request counts inside the popover instead of Unknown when occupancy is unknown", async () => {
    await act(async () =>
      root.render(
        <StatusBar
          contextMax={256_000}
          contextMaxKnown
          contextOccupancyKnown={false}
          contextShowCapacity
          contextCountsKnown
          contextLabel="Latest model request"
          contextSegments={[{ label: "Input", tokens: 54_900 }]}
        />,
      ),
    );
    const trigger = container.querySelector("button")!;
    await act(async () => trigger.click());
    const dialogText = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(dialogText).toContain("Latest model request");
    expect(dialogText).toContain("54.9k");
    expect(dialogText).not.toContain("Unknown / 256k");
  });
});
