import { describe, expect, it } from "vitest";
import { aggregateTps, parseThroughputStats } from "./throughput-stats";

const empty = {outputTokens:0,elapsedMs:0,completedTurns:0,excludedTurns:0};
describe("persisted throughput calculations", () => {
  it("accepts AGY totals without rejecting the whole statistics snapshot", () => {
    const agy = { outputTokens: 120, elapsedMs: 6000, completedTurns: 1, excludedTurns: 2 };
    const parsed = parseThroughputStats({ global: agy, session: agy, byEngine: { agy } });
    expect(parsed?.byEngine.agy).toEqual(agy);
    expect(aggregateTps(parsed?.global)).toBe(20);
    expect(parseThroughputStats({ global: agy, session: agy, byEngine: { unknown: agy } })).toBeUndefined();
  });
  it("uses total tokens divided by total observed time", () => {
    // 100 tokens in 1s and 100 tokens in 9s: 20 TPS, not (100 + 11.1) / 2.
    expect(aggregateTps({outputTokens:200,elapsedMs:10000,completedTurns:2,excludedTurns:4})).toBe(20);
    expect(aggregateTps({...empty,elapsedMs:1000,completedTurns:1})).toBe(0);
    expect(aggregateTps(empty)).toBeNull();
    expect(aggregateTps(undefined)).toBeNull();
  });
  it("rejects invalid or inconsistent aggregates instead of displaying a false zero", () => {
    for (const invalid of [null, {...empty,outputTokens:-1}, {...empty,elapsedMs:NaN},
      {...empty,completedTurns:1}, {...empty,outputTokens:1}, {...empty,excludedTurns:0.5}]) {
      expect(parseThroughputStats({global:invalid,session:empty,byEngine:{}})).toBeUndefined();
    }
    expect(parseThroughputStats({global:empty,session:empty,byEngine:{codex:null}})).toBeUndefined();
  });
  it("accepts isolated empty session totals while preserving global history", () => {
    const global = {outputTokens:1000,elapsedMs:20000,completedTurns:5,excludedTurns:2};
    const parsed = parseThroughputStats({global,session:empty,byEngine:{codex:global},startedAt:1900000000000});
    expect(parsed?.session).toEqual(empty);
    expect(aggregateTps(parsed?.global)).toBe(50);
    expect(parsed?.startedAt).toBe(1900000000000);
  });
});
