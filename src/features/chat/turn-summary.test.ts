import { describe, expect, it } from "vitest";
import { buildTurnSummary } from "./turn-summary";

describe("finished turn summary", () => {
  it("omits absent data and context-only snapshots", () => {
    expect(buildTurnSummary({})).toBeNull();
    expect(buildTurnSummary({ usage: { model_context_window: 1_000_000 } })).toBeNull();
    expect(buildTurnSummary({ usage: { context_usage_kind: "last_prompt", input_tokens: 900, output_tokens: 30 } })).toBeNull();
  });

  it("uses the whole turn duration, including tools and waits, for the average", () => {
    const summary = buildTurnSummary({ durationMs: 10_000, usage: {
      input_tokens: 100, cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100, output_tokens: 200, reasoning_output_tokens: 50,
    } }, 3);
    expect(summary).toEqual({ durationMs: 10_000, input: 1000, output: 200,
      usageComplete: true, cacheHitPercent: 80, reasoning: 50, tools: 3, outputTps: 20 });
  });

  it("does not double count Codex cached input or reasoning output", () => {
    const summary = buildTurnSummary({ usage: {
      input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200,
      reasoning_output_tokens: 150, total_tokens: 1200,
    } });
    expect(summary).toMatchObject({ input: 1000, output: 200, cacheHitPercent: 80, reasoning: 150 });
    expect(summary?.outputTps).toBeNull();
  });

  it("does not turn malformed counters or timer noise into statistics", () => {
    expect(buildTurnSummary({ usage: { input_tokens: -100, output_tokens: 200 } })).toBeNull();
    expect(buildTurnSummary({ usage: { input_tokens: Infinity } })).toBeNull();
    expect(buildTurnSummary({ durationMs: NaN })).toBeNull();
    expect(buildTurnSummary({ durationMs: 100, usage: { output_tokens: 200 } })?.outputTps).toBeNull();
    expect(buildTurnSummary({ durationMs: 1000 }, Infinity)).toMatchObject({ tools: 0, outputTps: null });
  });

  it("keeps incomplete native history counts without inventing a cache ratio or turn speed", () => {
    expect(buildTurnSummary({ durationMs: 5000, usage: {
      input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, usage_scope: "unknown",
    } })).toMatchObject({ input: 150, output: 20, usageComplete: false, cacheHitPercent: null, outputTps: null });
  });
  it("reads native turn billing while retaining a separate context snapshot", () => {
    expect(buildTurnSummary({ usage: {
      usage_scope: "turn", input_tokens: 100, output_tokens: 20,
      context_usage_kind: "current_context", context_usage: { input_tokens: 9999 },
    } })).toMatchObject({ input: 100, output: 20, usageComplete: true });
  });
});
