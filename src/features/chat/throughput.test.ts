import { describe, expect, it } from "vitest";
import { averageTps, beginThroughput, observedOutputTps, mergeThroughput, parseThroughput, settleThroughput, updateThroughput, type ThroughputSample } from "./throughput";

const sample: ThroughputSample = { version: 1, source: "claude", status: "complete", outputTokens: 100, elapsedMs: 10_000,
  generation: { outputTokens: 100, elapsedMs: 2000 }, generationReason: null };

describe("host throughput measurements", () => {
  it("accepts AGY turn observations without inventing generation timing", () => {
    const agy = parseThroughput({ ...sample, source: "agy", generation: null, generationReason: "unsupported" });
    expect(averageTps(agy)).toBe(10);
    expect(observedOutputTps(agy)).toBeNull();
    expect(averageTps(agy && { ...agy, outputTokens: null })).toBeNull();
    expect(averageTps(agy && { ...agy, status: "partial" })).toBeNull();
  });
  it("never treats legacy text-packet timing as generation speed", () => {
    expect(averageTps(sample)).toBe(10);
    expect(observedOutputTps(sample)).toBeNull();
    expect(parseThroughput(sample)?.generation).toBeNull();
    expect(averageTps({ ...sample, outputTokens: 0 })).toBe(0);
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("hides malformed token count %s", bad => {
    expect(averageTps({ ...sample, outputTokens: bad })).toBeNull();
    expect(observedOutputTps({ ...sample, outputRate: { basis: "usage_reports", outputTokens: bad, elapsedMs: 1, samples: 1, excludedSamples: 0 } })).toBeNull();
    expect(parseThroughput({ ...sample, outputTokens: bad })?.outputTokens).toBeNull();
  });
  it.each([NaN, Infinity, 0, -1, Number.MIN_VALUE])("hides unusable timing %s", bad => {
    expect(averageTps({ ...sample, elapsedMs: bad })).toBeNull();
    expect(observedOutputTps({ ...sample, outputRate: { basis: "usage_reports", outputTokens: 100, elapsedMs: bad, samples: 1, excludedSamples: 0 } })).toBeNull();
  });
  it("keeps valid response observations when the later turn is interrupted", () => {
    expect(averageTps({ ...sample, status: "partial" })).toBeNull();
    const outputRate = { basis: "usage_reports" as const, outputTokens: 80, elapsedMs: 2000, samples: 2, excludedSamples: 1 };
    expect(observedOutputTps({ ...sample, status: "partial", outputRate })).toBe(40);
    expect(observedOutputTps({ ...sample, outputRate: { ...outputRate, outputTokens: 1 } })).toBe(0.5);
    expect(parseThroughput({ ...sample, outputRate })?.outputRate).toEqual(outputRate);
    expect(averageTps(null)).toBeNull();
    expect(averageTps({ ...sample, outputTokens: null })).toBeNull();
  });
  it("validates paired observations and retains only known current-turn reasons", () => {
    const outputRate = { basis: "usage_reports", outputTokens: 0, elapsedMs: 0, samples: 0, excludedSamples: 2 };
    expect(parseThroughput({ ...sample, outputRate })?.outputRate).toEqual(outputRate);
    expect(observedOutputTps(parseThroughput({ ...sample, outputRate }))).toBeNull();
    for (const bad of [{...outputRate, samples: 1}, {...outputRate, outputTokens: 1}, {...outputRate, excludedSamples: -1}, {...outputRate, basis: "text_chunks"}]) {
      expect(parseThroughput({ ...sample, outputRate: bad })?.outputRate).toBeNull();
    }
    expect(parseThroughput({ ...sample, turnReason: "missing_baseline" })?.turnReason).toBe("missing_baseline");
    expect(parseThroughput({ ...sample, turnReason: "untrusted text" })?.turnReason).toBeNull();
  });
  it("rejects other contracts rather than treating old usage/genMs as throughput", () => {
    for (const bad of [null, {}, { output_tokens: 100, genMs: 2000 }, { ...sample, version: 2 },
      { ...sample, source: "pi" }, { ...sample, status: "success" }, { ...sample, generationReason: "made_up" }]) {
      expect(parseThroughput(bad)).toBeNull();
    }
  });
  it("rejects stale and wrong-run updates and seals a terminal sequence floor", () => {
    const current = updateThroughput(beginThroughput("run", 2), "run", 3, sample);
    expect(updateThroughput(current, "old", 4, sample)).toBe(current);
    expect(updateThroughput(current, "run", 3, sample)).toBe(current);
    const ended = settleThroughput(current, "run", false, 4)!;
    expect(ended.seq).toBe(4);
    expect(updateThroughput(ended, "run", 5, sample)).toBe(ended);
    expect(settleThroughput(current, "old", true)).toBe(current);
    expect(settleThroughput(current, "run", true, 1)).toBe(current);
  });
  it("merges the newer native sample only into its sender's own run", () => {
    const sender = beginThroughput("run", 1);
    const native = updateThroughput(beginThroughput("run"), "run", 2, sample);
    expect(mergeThroughput(sender, native)).toEqual(native);
    expect(mergeThroughput(sender, { ...native, runId: "old" })).toBe(sender);
    const stopped = settleThroughput(sender, "run", true)!;
    expect(mergeThroughput(stopped, native)).toBe(stopped);
  });
});
