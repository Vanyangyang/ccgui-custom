import { describe, expect, it } from "vitest";
import { estimatePendingRequestCost } from "./pending-request-cost";

const start = Date.parse("2026-10-28T00:00:00Z");
const transition = Date.parse("2026-12-01T00:00:00Z");
const expiry = Date.parse("2027-01-01T00:00:00Z");
const defaults = {
  engine: "agy",
  model: "gemini-4-argon",
  prompt: "abcd",
  context: { used: 1_000, kind: "current_context" as const },
  now: start,
};

describe("estimatePendingRequestCost", () => {
  it.each([
    ["", 0, 0, 0],
    ["abcd", 4, 4, 1],
    ["中文😀", 3, 10, 3],
    ["e\u0301", 2, 3, 1],
    ["👨‍👩‍👧‍👦", 7, 25, 7],
  ])("counts codepoints and UTF-8 bytes for %j without rewriting text", (prompt, characters, bytes, lower) => {
    const result = estimatePendingRequestCost({ ...defaults, prompt });
    expect(result.method).toBe("utf8-quarter-to-byte-v1");
    expect(result.textCharacters).toBe(characters);
    expect(result.textUtf8Bytes).toBe(bytes);
    expect(result.textTokens).toEqual({ lower, upper: bytes });
    expect(result).not.toHaveProperty("prompt");
  });

  it("uses cache-read only for the context lower bound, with fresh text in both bounds", () => {
    const result = estimatePendingRequestCost(defaults);
    expect(result.contextBasis).toBe("current_context");
    expect(result.contextTokens).toBe(1_000);
    expect(result.inputTokens).toEqual({ lower: 1_001, upper: 1_004 });
    expect(result.inputUsd?.lower).toBeCloseTo((1_000 * 0.1 + 1 * 2) / 1_000_000);
    expect(result.inputUsd?.upper).toBeCloseTo((1_000 + 4) * 2 / 1_000_000);
  });

  it("preserves the last-request basis instead of calling it current context", () => {
    const result = estimatePendingRequestCost({ ...defaults, context: { used: 42, kind: "last_request" } });
    expect(result.contextBasis).toBe("last_request");
    expect(result.inputTokens).toEqual({ lower: 43, upper: 46 });
  });

  it.each([undefined, -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid context usage %s", (used) => {
    const result = estimatePendingRequestCost({ ...defaults, context: { used, kind: "current_context" } });
    expect(result.contextBasis).toBe("current_context");
    expect(result.contextTokens).toBeUndefined();
    expect(result.inputTokens).toBeUndefined();
    expect(result.inputUsd).toBeUndefined();
    expect(result.pricing).toBeDefined();
  });

  it("keeps genuine zero context and distinguishes zero images from unknown", () => {
    const result = estimatePendingRequestCost({ ...defaults, prompt: "", imageCount: 0, context: { used: 0, kind: "current_context" } });
    expect(result.contextTokens).toBe(0);
    expect(result.inputTokens).toEqual({ lower: 0, upper: 0 });
    expect(result.inputUsd).toEqual({ lower: 0, upper: 0 });
    expect(result.imageCount).toBe(0);
    expect(estimatePendingRequestCost(defaults).imageCount).toBeUndefined();
    expect(estimatePendingRequestCost({ ...defaults, imageCount: 3 }).imageCount).toBe(3);
  });

  it.each([
    { used: 1_000, kind: "unknown" as const },
    { used: 1_000, kind: "current_context" as const, modelMismatch: true },
    { used: 1_000, kind: "last_request" as const, modelMismatch: true },
  ])("does not sum unknown or mismatched context %j", (context) => {
    const result = estimatePendingRequestCost({ ...defaults, context });
    expect(result.contextBasis).toBe(context.modelMismatch ? "model_mismatch" : "unknown");
    expect(result.contextTokens).toBeUndefined();
    expect(result.inputTokens).toBeUndefined();
    expect(result.inputUsd).toBeUndefined();
  });

  it.each([
    ["agy", "gemini-4"], ["agy", "gemini-4-argon-preview"],
    ["agy", "Gemini-4-argon"], ["agy", "gemini-4-argon "],
    ["codex", "gemini-4-argon"], ["agy", ""],
  ])("requires exact verified engine/model %s/%s", (engine, model) => {
    const result = estimatePendingRequestCost({ ...defaults, engine, model });
    expect(result.unavailableReason).toBe("model_price_unverified");
    expect(result.pricing).toBeUndefined();
    expect(result.inputUsd).toBeUndefined();
    expect(result.inputTokens).toEqual({ lower: 1_001, upper: 1_004 });
  });

  it.each([start, transition - 1])("returns first-stage source and validity at %s", (now) => {
    expect(estimatePendingRequestCost({ ...defaults, now }).pricing).toEqual({
      model: "gemini-4-argon",
      sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing#gemini-4-argon",
      checkedAt: "2026-10-28",
      effectiveFrom: start,
      effectiveUntil: transition,
      inputUsdPerMillion: 2,
      cacheReadUsdPerMillion: 0.1,
      outputUsdPerMillion: 10,
      basis: "api_standard_reference",
    });
  });

  it.each([transition, expiry - 1])("switches price at the exact UTC transition %s", (now) => {
    const result = estimatePendingRequestCost({ ...defaults, now });
    expect(result.pricing).toMatchObject({ effectiveFrom: transition, effectiveUntil: expiry, inputUsdPerMillion: 4, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 20 });
    expect(result.inputUsd?.lower).toBeCloseTo((1_000 * 0.2 + 1 * 4) / 1_000_000);
    expect(result.inputUsd?.upper).toBeCloseTo(1_004 * 4 / 1_000_000);
  });

  it.each([start - 1, expiry, expiry + 1, NaN, Infinity])("does not quote outside the verified catalog period %s", (now) => {
    const result = estimatePendingRequestCost({ ...defaults, now });
    expect(result.unavailableReason).toBe("price_outdated");
    expect(result.pricing).toBeUndefined();
    expect(result.inputUsd).toBeUndefined();
  });
});
