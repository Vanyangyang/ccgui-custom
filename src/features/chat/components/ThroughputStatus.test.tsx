import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ThroughputStatus } from "./ThroughputStatus";
import { beginThroughput, type ThroughputSample } from "../throughput";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const sample: ThroughputSample = {
  version: 1,
  source: "codex_app_server",
  status: "complete",
  outputTokens: 100,
  elapsedMs: 10_000,
  generation: { outputTokens: 100, elapsedMs: 2000 },
  generationReason: null,
  model: "gpt-5.4",
  breakdown: { modelMs: 10_000, toolMs: 5_000, waitMs: 2_000, startupMs: 3_000, wallMs: 20_000 },
};

describe("composer throughput status", () => {
  let container: HTMLDivElement;
  let root: Root;
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
  const render = async (value?: ThroughputSample) => {
    await act(async () =>
      root.render(<ThroughputStatus throughput={value ? { ...beginThroughput("run"), sample: value } : null} />),
    );
  };
  const open = async () => {
    await act(async () => container.querySelector("button")!.click());
    return document.querySelector('[role="dialog"]')!;
  };

  it("displays active-time model inference rate, stage breakdown and end-to-end rate without negative warnings", async () => {
    await render(sample);
    expect(container.textContent).toBe("Turn 10 tok/s");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("Turn complete");
    expect(container.querySelector("button span")?.getAttribute("title")).toContain("active model inference time");
    const dialog = await open();
    expect(dialog.textContent).not.toContain("49.5");
    expect(dialog.textContent).not.toContain("model generation speed is unavailable");
    expect(dialog.textContent).not.toContain("Observed stream rate");
    expect(dialog.textContent).toContain("Model 10.0s · Tools 5.0s · Wait 2.0s · Startup 3.0s · Wall 20.0s");
    expect(dialog.textContent).toContain("End-to-end turn rate");
    expect(dialog.textContent).toContain("5 tok/s");
    expect(dialog.textContent).toContain("Source: Codex · gpt-5.4");
  });

  it("hides unscoped entry when no valid rate is measured (including 0-token, <1s, >1000 tok/s, AGY and Cursor)", async () => {
    for (const value of [
      undefined,
      { ...sample, status: "partial" as const },
      { ...sample, outputTokens: 0 },
      { ...sample, elapsedMs: 800 },
      { ...sample, outputTokens: 25_000, elapsedMs: 1_000 },
      { ...sample, outputTokens: null, turnReason: "missing_baseline" as const },
      { ...sample, source: "agy" as const, outputTokens: null },
      { ...sample, source: "cursor" as const, outputTokens: null },
    ]) {
      await render(value);
      expect(container.textContent).toBe("");
      expect(container.querySelector("button")).toBeNull();
    }
  });

  it("shows completed Claude response observations even if the turn later fails", async () => {
    await render({
      ...sample,
      source: "claude",
      status: "partial",
      turnReason: "interrupted",
      outputRate: { basis: "usage_reports", outputTokens: 80, elapsedMs: 2000, samples: 2, excludedSamples: 1 },
    });
    expect(container.textContent).toBe("Observed stream rate 40 tok/s");
    const dialog = await open();
    expect(dialog.textContent).toContain("Observed stream rate40 tok/s");
    expect(dialog.textContent).toContain("Measured responses: 2 / 3");
    expect(dialog.textContent).toContain("Turn interrupted or failed");
  });

  it("renders Chinese labels, live streaming estimates and report-driven updates without a polling timer", async () => {
    await i18n.changeLanguage("zh");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const polling = vi.spyOn(window, "setInterval");
    await render({
      version: 1,
      source: "cursor",
      status: "running",
      outputTokens: null,
      elapsedMs: 1_500,
      generation: null,
      generationReason: "unsupported",
      liveEstimate: { outputTokens: 72, elapsedMs: 1_500, estimated: true },
    });
    expect(container.textContent).toBe("预估 ~48 tok/s");
    expect(container.querySelector("button span")?.getAttribute("title")).toContain("工具执行与等待期间自动暂停");
    await render({ ...sample, source: "cursor", outputTokens: 200, elapsedMs: 10_000 });
    expect(container.textContent).toBe("本轮 20 tok/s");
    expect(polling).not.toHaveBeenCalled();
  });

  it("provides wrapping and viewport-bounded details for narrow layouts", async () => {
    container.style.width = "240px";
    await render(sample);
    const button = container.querySelector("button")!;
    expect(button.classList.contains("flex-wrap")).toBe(true);
    expect(button.classList.contains("max-w-full")).toBe(true);
    const dialog = await open();
    expect(dialog.closest("[data-rac]")?.parentElement?.className || dialog.parentElement?.className).toContain(
      "max-w-[calc(100vw-2rem)]",
    );
  });
});
