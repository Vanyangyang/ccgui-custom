import { beforeEach, describe, expect, it } from "vitest";
import {
  readAgyReferenceWindow,
  selectAgyContext,
  writeAgyReferenceWindow,
} from "./agy-context";

describe("AGY context provenance", () => {
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

  it("requires explicit current-context provenance and real capacity for a percentage when no reference window is set", () => {
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

  it("calculates reference percentage from last_prompt when a valid frontend reference window is configured", () => {
    const usage = {
      context_usage_kind: "last_prompt",
      context_usage: { input_tokens: 40_000, output_tokens: 10_000 },
    };
    const result = selectAgyContext(usage, 200_000);
    expect(result).toMatchObject({
      max: 200_000,
      reportedMax: undefined,
      capacityKnown: true,
      occupancyKnown: true,
      countsKnown: true,
      total: 50_000,
      pct: 25,
      labelKey: "chat.agyLatestModelRequest",
      noteKey: "chat.agyReferenceWindowNote",
    });
  });

  it("reads, validates, and clears the persisted frontend reference window", () => {
    expect(readAgyReferenceWindow()).toBeUndefined();
    writeAgyReferenceWindow(1_000_000);
    expect(readAgyReferenceWindow()).toBe(1_000_000);
    expect(() => writeAgyReferenceWindow(50_000)).toThrow();
    expect(() => writeAgyReferenceWindow(2_500_000)).toThrow();
    expect(readAgyReferenceWindow()).toBe(1_000_000);
    writeAgyReferenceWindow(undefined);
    expect(readAgyReferenceWindow()).toBeUndefined();
  });

  it("shows a known model capacity without inventing current occupancy", () => {
    const usage = { context_usage_kind: "last_prompt", context_usage: { input_tokens: 100 } };
    expect(selectAgyContext(usage, undefined, 1_000_000)).toMatchObject({
      max: 1_000_000, capacityKnown: true, occupancyKnown: false, pct: undefined,
    });
    expect(selectAgyContext(null, undefined, 1_000_000).capacityKnown).toBe(true);
    expect(selectAgyContext(usage, 200_000, 1_000_000).max).toBe(200_000);
    expect(selectAgyContext({ ...usage, model_context_window: 500_000 }, 200_000, 1_000_000).max).toBe(500_000);
    for (const invalid of [NaN, Infinity, -1, 0, 1.5]) {
      expect(selectAgyContext(null, undefined, invalid).capacityKnown).toBe(false);
    }
  });
});
