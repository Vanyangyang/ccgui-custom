import { beforeEach, describe, expect, it } from "vitest";
import { selectAgyContext } from "./agy-context";

describe("AGY context provenance", () => {
  it("shows empty official occupancy and prioritizes its capacity over model windows", () => {
    for (const used of [100_000, 20_000, 0]) {
      expect(selectAgyContext({
        context_usage_kind: "current_context", context_usage_source: "acp_usage_update",
        context_usage: { input_tokens: used, output_tokens: 0 }, model_context_window: 1_000_000,
      }, 500_000)).toMatchObject({
        total: used, pct: used / 10_000, max: 1_000_000,
        parts: used ? [{ kind: "total", tokens: used }] : [],
        countsKnown: true, occupancyKnown: true, capacityKnown: true, noteKey: undefined,
      });
    }
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("never treats billing as occupancy, even with a real capacity", () => {
    for (const usage of [null, { input_tokens: 800000 }, { input_tokens: 800000, model_context_window: 1000000 }]) {
      const result = selectAgyContext(usage);
      expect(result.occupancyKnown).toBe(false);
      expect(result.countsKnown).toBe(false);
      expect(result.parts).toEqual([]);
      expect(result.pct).toBeUndefined();
    }
  });

  it("labels only the latest model request counts and never invents capacity or percentage", () => {
    const result = selectAgyContext({
      input_tokens: 800000,
      session_usage: { total_tokens: 9000000 },
      context_usage_kind: "last_prompt",
      context_usage: { input_tokens: 40, output_tokens: 10 },
    });
    expect(result).toMatchObject({
      total: 50,
      countsKnown: true,
      occupancyKnown: false,
      capacityKnown: false,
      labelKey: "chat.agyLatestModelRequest",
    });
    expect(result.max).toBeUndefined();
    expect(result.reportedMax).toBeUndefined();
    expect(result.pct).toBeUndefined();
    expect(result.parts).toEqual([
      { kind: "input", tokens: 40 },
      { kind: "output", tokens: 10 },
    ]);
  });

  it("requires explicit current-context provenance and real capacity for a percentage ", () => {
    const base = { context_usage: { input_tokens: 100 }, model_context_window: 1000 };
    expect(selectAgyContext({ ...base, context_usage_kind: "last_prompt" }).pct).toBeUndefined();
    expect(selectAgyContext({ ...base, context_usage_kind: "current_context" }).pct).toBe(10);
    expect(selectAgyContext({ context_usage_kind: "current_context", context_usage: base.context_usage }).pct).toBeUndefined();
    expect(selectAgyContext({ ...base, context_usage_kind: "billing" }).parts).toEqual([]);
  });

  it("takes only explicit capacity metadata from cumulative session accounting", () => {
    const result = selectAgyContext({
      usage_scope: "turn",
      output_tokens: 20,
      session_usage: { input_tokens: 9000000, model_context_window: 1000000 },
      context_usage_kind: "last_prompt",
      context_usage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(result.max).toBe(1000000);
    expect(result.reportedMax).toBe(1000000);
    expect(result.total).toBe(120);
    expect(result.occupancyKnown).toBe(false);
    expect(result.pct).toBeUndefined();
  });

  it("shows a known model capacity without inventing current occupancy", () => {
    localStorage.setItem("ccgui.agy.reference-context-window", "200000");
    const usage = { context_usage_kind: "last_prompt", context_usage: { input_tokens: 100 } };
    expect(selectAgyContext(usage).capacityKnown).toBe(false);
    expect(selectAgyContext(usage, 1_000_000)).toMatchObject({
      max: 1_000_000, capacityKnown: true, occupancyKnown: false, pct: undefined,
    });
    expect(selectAgyContext(null, 1_000_000).capacityKnown).toBe(true);
    expect(selectAgyContext({ ...usage, model_context_window: 500_000 }, 1_000_000).max).toBe(500_000);
    for (const invalid of [NaN, Infinity, -1, 0, 1.5]) {
      expect(selectAgyContext(null, invalid).capacityKnown).toBe(false);
    }
  });

});
