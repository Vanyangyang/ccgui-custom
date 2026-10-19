import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ThroughputStatus } from "./ThroughputStatus";
import { beginThroughput, type ThroughputSample } from "../throughput";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const sample: ThroughputSample = { version: 1, source: "codex_app_server", status: "complete", outputTokens: 100, elapsedMs: 10_000,
  generation: { outputTokens: 100, elapsedMs: 2000 }, generationReason: null };

describe("composer throughput status", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  const render = async (value?: ThroughputSample) => {
    await act(async () => root.render(<ThroughputStatus throughput={value ? { ...beginThroughput("run"), sample: value } : null} />));
  };
  const open = async () => { await act(async () => container.querySelector("button")!.click()); return document.querySelector('[role="dialog"]')!; };
  it("labels whole-turn throughput and suppresses unsupported legacy generation rates", async () => {
    await render(sample);
    expect(container.textContent).toBe("Turn 10 tokens/s");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("Turn complete");
    expect(container.querySelector("button span")?.getAttribute("title")).toContain("including waiting, tools and thinking");
    const dialog = await open();
    expect(dialog.textContent).not.toContain("49.5");
    expect(dialog.textContent).not.toContain("first packet");
    expect(dialog.textContent).toContain("model generation speed is unavailable");
    expect(dialog.textContent).not.toContain("Observed stream rate");
    expect(dialog.textContent).toContain("not live token-by-token");
    expect(dialog.textContent).toContain("Codex");
  });
  it("hides the entry when no valid rate is measured, including AGY", async () => {
    for (const value of [undefined, { ...sample, status: "partial" as const },
      { ...sample, outputTokens: null, turnReason: "missing_baseline" as const },
      { ...sample, source: "agy" as const, outputTokens: null }]) {
      await render(value);
      expect(container.textContent).toBe("");
      expect(container.querySelector("button")).toBeNull();
    }
  });
  it("keeps a measured zero rate visible", async () => {
    await render({ ...sample, source: "agy", outputTokens: 0 });
    expect(container.textContent).toBe("Turn 0 tokens/s");
  });
  it("shows completed Claude response observations even if the turn later fails", async () => {
    await render({ ...sample, source: "claude", status: "partial", turnReason: "interrupted",
      outputRate: { basis: "usage_reports", outputTokens: 80, elapsedMs: 2000, samples: 2, excludedSamples: 1 } });
    expect(container.textContent).toBe("Observed stream rate 40 tokens/s");
    const dialog = await open();
    expect(dialog.textContent).toContain("Observed stream rate40 tokens/s");
    expect(dialog.textContent).toContain("Measured responses: 2 / 3");
    expect(dialog.textContent).toContain("Turn interrupted or failed");
    expect(dialog.textContent).not.toContain("model generation speed is unavailable");
  });
  it("uses Chinese labels and report-driven updates without a polling timer", async () => {
    await i18n.changeLanguage("zh");
    // JSDOM implements requestAnimationFrame with a 60Hz interval. Isolate
    // frame scheduling so this assertion measures component-owned polling.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const polling = vi.spyOn(window, "setInterval");
    await render({ ...sample, status: "running" });
    expect(container.textContent).toBe("本轮效率 10 tokens/s");
    expect(container.querySelector("button span")?.getAttribute("title")).toContain("按引擎用量报告更新");
    await render({ ...sample, outputTokens: 200 });
    expect(container.textContent).toBe("本轮效率 20 tokens/s");
    expect(polling).not.toHaveBeenCalled();
  });
  it("provides wrapping and viewport-bounded details for narrow layouts", async () => {
    container.style.width = "240px";
    await render(sample);
    const button = container.querySelector("button")!;
    expect(button.classList.contains("flex-wrap")).toBe(true);
    expect(button.classList.contains("max-w-full")).toBe(true);
    const dialog = await open();
    expect(dialog.closest('[data-rac]')?.parentElement?.className || dialog.parentElement?.className).toContain("max-w-[calc(100vw-2rem)]");
  });
});
