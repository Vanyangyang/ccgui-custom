import { describe, expect, it } from "vitest";
import { cursorContextOccupancyKnown, mergeUsage, parseUsage, reportedContextWindow, selectCursorContext } from "./usage";
import { usageBreakdown } from "./components/usage-breakdown";

describe("cursor context occupancy", () => {
  it("accepts one request inside the selected window and rejects a summed run", () => {
    const oneCall = { input_tokens: 20_000, output_tokens: 1_000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 };
    const summed = { input_tokens: 1_200_000, output_tokens: 80_000, cache_read_input_tokens: 3_000_000, cache_creation_input_tokens: 0 };
    expect(cursorContextOccupancyKnown(oneCall, 256_000)).toBe(true);
    expect(cursorContextOccupancyKnown(summed, 256_000)).toBe(false);
    expect(cursorContextOccupancyKnown(null, 256_000)).toBe(false);
  });

  it("uses the local conversation state's current occupancy instead of the summed run", () => {
    const selected = selectCursorContext({
      input_tokens: 1_200_000,
      output_tokens: 80_000,
      cache_read_input_tokens: 3_000_000,
      context_usage_kind: "current_context",
      context_usage: {
        used_tokens: 143_356,
        model_context_window: 256_000,
        categories: [
          { id: "conversation", tokens: 123_394 },
          { id: "rules", tokens: 19_962 },
          { id: "not a category", tokens: 10 },
        ],
      },
    }, 500_000);
    expect(selected).toMatchObject({
      occupancyKnown: true,
      max: 256_000,
      used: 143_356,
      pct: 56,
    });
    expect(selected.categories).toEqual([
      { id: "conversation", tokens: 123_394 },
      { id: "rules", tokens: 19_962 },
    ]);
    expect(selectCursorContext({ input_tokens: 1_200_000 }, 256_000).occupancyKnown).toBe(false);
  });
});

describe("parseUsage", () => {
  it("recognizes 1M metadata before tokens arrive and rejects invalid capacities", () => {
    expect(reportedContextWindow({ contextWindow: "1M" })).toBe(1_000_000);
    for (const value of [0, -1, Infinity, "-1M", "unknown"]) {
      expect(reportedContextWindow({ model_context_window: value })).toBeUndefined();
    }
  });
  it.each([1_000_000, "1M", "1000000"])("recognizes a %s context window from token_count info", (window) => {
    const parsed = parseUsage({ info: { model_context_window: window,
      last_token_usage: { input_tokens: 89000, output_tokens: 1000 },
      total_token_usage: { input_tokens: 2000000, output_tokens: 50000 } } });
    expect(parsed?.contextWindow).toBe(1_000_000);
    expect(parsed?.total).toBe(90000);
    expect(usageBreakdown({ input_tokens: 90000 }, parsed!.contextWindow!)?.pct).toBe(9);
  });

  it("folds a codex record's cache counters out of its input", () => {
    // The session-log tail emits token_usage_record payloads: a flat usage
    // with codex's own cache field names and the stamped context window.
    // Codex bills `input_tokens` as the whole prompt and reports
    // `total_tokens` = input + output, so the cache counters are already
    // inside input and must not be added again.
    const parsed = parseUsage({
      input_tokens: 8000,
      cached_input_tokens: 6000,
      cache_write_input_tokens: 1500,
      output_tokens: 300,
      total_tokens: 8300,
      model_context_window: 258_400,
    });
    expect(parsed).toMatchObject({
      input: 500,
      output: 300,
      cacheRead: 6000,
      cacheWrite: 1500,
      total: 8300,
      contextWindow: 258_400,
    });
    expect(
      parsed!.input + parsed!.output + parsed!.cacheRead + parsed!.cacheWrite,
    ).toBe(parsed!.total);
  });

  it("keeps claude's cache tokens outside its input", () => {
    // Claude reports fresh input separately from the cache it read and wrote,
    // so there the cache volume is missing input rather than a subset of it.
    const parsed = parseUsage({
      input_tokens: 400,
      cache_read_input_tokens: 6000,
      cache_creation_input_tokens: 1500,
      output_tokens: 300,
    });
    expect(parsed).toMatchObject({
      input: 400,
      output: 300,
      cacheRead: 6000,
      cacheWrite: 1500,
      total: 8200,
    });
  });

  it("reads a flattened last-turn snapshot with the window copied on", () => {
    const parsed = parseUsage({
      input_tokens: 34_660,
      output_tokens: 85,
      total_tokens: 34_745,
      model_context_window: 475_000,
    });
    expect(parsed?.contextWindow).toBe(475_000);
    expect(parsed?.total).toBe(34_745);
  });
});

describe("mergeUsage", () => {
  it("keeps a previously reported context window", () => {
    const merged = mergeUsage(
      { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      { input_tokens: 8, output_tokens: 1, total_tokens: 9, model_context_window: 475_000 },
    );
    expect(merged).toMatchObject({
      input_tokens: 10,
      total_tokens: 12,
      model_context_window: 475_000,
    });
  });

  it("keeps Cursor's current occupancy when a later billing snapshot omits it", () => {
    const context = {
      used_tokens: 143_356,
      model_context_window: 256_000,
      categories: [{ id: "conversation", tokens: 143_356 }],
    };
    const merged = mergeUsage(
      { input_tokens: 1_200_000, output_tokens: 80_000 },
      { input_tokens: 20, context_usage_kind: "current_context", context_usage: context },
    );
    expect(merged).toMatchObject({
      input_tokens: 1_200_000,
      context_usage_kind: "current_context",
      context_usage: context,
    });
    expect(selectCursorContext(merged, 256_000).pct).toBe(56);
  });
});

describe("usageBreakdown", () => {
  /** 验证空用量安全返回 null */
  it("returns null when usage cannot be parsed", () => {
    expect(usageBreakdown(null, 200000)).toBeNull();
  });

  /** 验证按调用方解析出的 maxTokens 计算百分比 */
  it("computes pct against the provided maxTokens", () => {
    const breakdown = usageBreakdown(
      { input_tokens: 10000, output_tokens: 2000, total_tokens: 12000 },
      200000,
    );
    expect(breakdown).not.toBeNull();
    // 12000 / 200000 = 6%
    expect(breakdown?.pct).toBe(6);
    // 分段相加必须等于 total (10000 + 2000 = 12000)
    const sumSegments = breakdown?.parts.reduce((sum, p) => sum + p.tokens, 0);
    expect(sumSegments).toBe(12000);
  });

  /** 验证畸形 payload 的负 token 不会得到负百分比 */
  it("clamps pct at zero for negative token counts", () => {
    const breakdown = usageBreakdown(
      { input_tokens: -5000, output_tokens: 0, total_tokens: -5000 },
      200000,
    );
    expect(breakdown?.pct).toBe(0);
  });
});
