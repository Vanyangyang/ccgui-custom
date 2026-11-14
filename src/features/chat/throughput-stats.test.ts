// @vitest-environment node
import { describe, expect, it } from "vitest";
import { aggregateTps, parseThroughputStats } from "./throughput-stats";

const empty = { outputTokens: 0, elapsedMs: 0, completedTurns: 0, excludedTurns: 0 };
describe("persisted throughput calculations", () => {
  it("accepts AGY, Cursor and model-grouped totals without rejecting the snapshot", () => {
    const agy = { outputTokens: 120, elapsedMs: 6000, completedTurns: 1, excludedTurns: 2 };
    const cursor = {
      outputTokens: 300,
      elapsedMs: 5000,
      completedTurns: 2,
      excludedTurns: 3,
      interruptedTurns: 1,
      missingTurns: 2,
      medianTps: 58.5,
    };
    const parsed = parseThroughputStats({
      global: cursor,
      session: agy,
      byEngine: { agy, cursor },
      byModel: { "gemini-4-argon": agy, "claude-4.6-opus": cursor },
    });
    expect(parsed?.byEngine.agy).toEqual(agy);
    expect(parsed?.byEngine.cursor).toEqual(cursor);
    expect(parsed?.byModel?.["claude-4.6-opus"]).toEqual(cursor);
    expect(aggregateTps(parsed?.global)).toBe(60);
    expect(parseThroughputStats({ global: agy, session: agy, byEngine: { unknown: agy } })).toBeUndefined();
  });

  it("uses total tokens divided by total active model time and hides zero-token totals", () => {
    // 100 tokens in 1s and 100 tokens in 9s: 20 TPS, not (100 + 11.1) / 2.
    expect(aggregateTps({ outputTokens: 200, elapsedMs: 10000, completedTurns: 2, excludedTurns: 4 })).toBe(20);
    expect(aggregateTps({ ...empty, elapsedMs: 1000, completedTurns: 1 })).toBeNull();
    expect(aggregateTps(empty)).toBeNull();
    expect(aggregateTps(undefined)).toBeNull();
  });

  it("rejects invalid or inconsistent aggregates instead of displaying a false zero", () => {
    for (const invalid of [
      null,
      { ...empty, outputTokens: -1 },
      { ...empty, elapsedMs: NaN },
      { ...empty, completedTurns: 1 },
      { ...empty, outputTokens: 1 },
      { ...empty, excludedTurns: 0.5 },
      { outputTokens: 100, elapsedMs: 2000, completedTurns: 1, excludedTurns: 1, interruptedTurns: 1, missingTurns: 1 },
    ]) {
      expect(parseThroughputStats({ global: invalid, session: empty, byEngine: {} })).toBeUndefined();
    }
    expect(parseThroughputStats({ global: empty, session: empty, byEngine: { codex: null } })).toBeUndefined();
    expect(parseThroughputStats({ global: empty, session: empty, byEngine: {}, byModel: { "": empty } })).toBeUndefined();
  });

  it("accepts isolated empty session totals while preserving global history", () => {
    const global = { outputTokens: 1000, elapsedMs: 20000, completedTurns: 5, excludedTurns: 2 };
    const parsed = parseThroughputStats({ global, session: empty, byEngine: { codex: global }, startedAt: 1900000000000 });
    expect(parsed?.session).toEqual(empty);
    expect(aggregateTps(parsed?.global)).toBe(50);
    expect(parsed?.startedAt).toBe(1900000000000);
  });
});
