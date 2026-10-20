import { describe, expect, it } from "vitest";
import { buildTurnSummary } from "./turn-summary";
import { parseUsage } from "./usage";

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

  it("uses verified Codex whole-turn throughput sample (20 tok/s) instead of last request output divided by turn duration (0.3 tok/s)", () => {
    // 【Codex多请求回归】last output 90、本轮 output 6000 / 300000ms => 整轮效率 20 而非 0.3；通用 parseUsage 仍返回 last 请求占用。
    const usage = {
      usage_scope: "last_request",
      input_tokens: 45_000,
      cached_input_tokens: 36_000,
      output_tokens: 90,
      reasoning_output_tokens: 40,
      total_tokens: 45_090,
      turn_throughput: { output_tokens: 6_000, elapsed_ms: 300_000 },
    };
    expect(parseUsage(usage)).toMatchObject({
      input: 9_000,
      cacheRead: 36_000,
      output: 90,
      total: 45_090,
    });
    const summary = buildTurnSummary({ durationMs: 300_000, usage }, 12);
    expect(summary).toEqual({
      durationMs: 300_000,
      input: 45_000,
      output: 6_000,
      usageComplete: false,
      cacheHitPercent: null,
      reasoning: 40,
      tools: 12,
      outputTps: 20,
    });
  });

  it("marks Codex last-request usage as partial and hides cache ratio and throughput when no verified sample exists", () => {
    // 【Codex缺基线与历史回归】无 turn_throughput 或样本非法时，不回落到 last 请求除整轮耗时（0.3 tok/s）。
    const liveWithoutSample = buildTurnSummary({
      durationMs: 300_000,
      usage: {
        usage_scope: "last_request",
        input_tokens: 45_000,
        cached_input_tokens: 36_000,
        output_tokens: 90,
        total_tokens: 45_090,
      },
    });
    expect(liveWithoutSample).toMatchObject({
      input: 45_000,
      output: 90,
      usageComplete: false,
      cacheHitPercent: null,
      outputTps: null,
    });

    const rawHistory = buildTurnSummary({
      durationMs: 300_000,
      usage: {
        info: {
          last_token_usage: { input_tokens: 45_000, cached_input_tokens: 36_000, output_tokens: 90, total_tokens: 45_090 },
          total_token_usage: { input_tokens: 500_000, output_tokens: 20_000, total_tokens: 520_000 },
        },
      },
    });
    expect(rawHistory).toMatchObject({
      input: 45_000,
      output: 90,
      usageComplete: false,
      cacheHitPercent: null,
      outputTps: null,
    });

    for (const bad of [
      { output_tokens: -1, elapsed_ms: 1000 },
      { output_tokens: 100, elapsed_ms: 0 },
      { output_tokens: 100, elapsed_ms: -5 },
      { output_tokens: 100, elapsed_ms: 999 },
      { output_tokens: NaN, elapsed_ms: 1000 },
      { output_tokens: 1.5, elapsed_ms: 1000 },
    ]) {
      expect(
        buildTurnSummary({
          durationMs: 300_000,
          usage: { usage_scope: "last_request", input_tokens: 1000, output_tokens: 90, turn_throughput: bad },
        })?.outputTps,
      ).toBeNull();
    }
  });

  it("does not restore efficiency from stale paired metadata on an interrupted reply", () => {
    expect(buildTurnSummary({ durationMs: 10_000, usage: {
      usage_scope: "turn", turn_status: "partial",
      input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 100,
      turn_throughput: { output_tokens: 6000, elapsed_ms: 300_000 },
    } })).toMatchObject({ input: 1100, output: 400, usageComplete: false,
      cacheHitPercent: null, outputTps: null });
  });

  it("preserves Claude history request counts without deriving a whole-turn rate or cache ratio", () => {
    const message = JSON.parse(JSON.stringify({ durationMs: 300_000, usage: {
      usage_scope: "last_request", input_tokens: 1000, cache_read_input_tokens: 800, output_tokens: 90,
    } }));
    expect(parseUsage(message.usage)).toMatchObject({ input: 1000, cacheRead: 800, output: 90 });
    expect(buildTurnSummary(message)).toMatchObject({ input: 1800, output: 90,
      usageComplete: false, cacheHitPercent: null, outputTps: null });
  });
});
