// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  averageTps,
  beginThroughput,
  endToEndTps,
  formatTps,
  liveEstimateTps,
  mergeThroughput,
  observedOutputTps,
  parseThroughput,
  settleThroughput,
  updateThroughput,
  type ThroughputSample,
} from "./throughput";

const sample: ThroughputSample = {
  version: 1,
  source: "claude",
  status: "complete",
  outputTokens: 100,
  elapsedMs: 10_000,
  generation: { outputTokens: 100, elapsedMs: 2000 },
  generationReason: null,
};

describe("host throughput measurements", () => {
  it("accepts AGY and Cursor turn observations without inventing generation timing", () => {
    for (const source of ["agy", "cursor"] as const) {
      const parsed = parseThroughput({ ...sample, source, generation: null, generationReason: "unsupported" });
      expect(averageTps(parsed)).toBe(10);
      expect(observedOutputTps(parsed)).toBeNull();
      expect(averageTps(parsed && { ...parsed, outputTokens: null })).toBeNull();
      expect(averageTps(parsed && { ...parsed, status: "partial" })).toBeNull();
    }
  });

  it("enforces active-time plausibility gates (tokens > 0, >=1s complete, <=1000 tok/s)", () => {
    expect(averageTps(sample)).toBe(10);
    expect(observedOutputTps(sample)).toBeNull();
    expect(parseThroughput(sample)?.generation).toBeNull();
    // 0-token, <1s complete, and >1000 tok/s spikes are excluded instead of distorting TPS
    expect(averageTps({ ...sample, outputTokens: 0 })).toBeNull();
    expect(averageTps({ ...sample, elapsedMs: 999 })).toBeNull();
    expect(averageTps({ ...sample, status: "running", elapsedMs: 600, outputTokens: 30 })).toBe(50);
    expect(averageTps({ ...sample, status: "running", elapsedMs: 499, outputTokens: 30 })).toBeNull();
    expect(averageTps({ ...sample, outputTokens: 25_000, elapsedMs: 1_000 })).toBeNull();
    expect(averageTps({ ...sample, outputTokens: 1_000, elapsedMs: 1_000 })).toBe(1_000);
    expect(averageTps({ ...sample, turnReason: "subagent_mixed" })).toBeNull();
  });

  it("parses active-time breakdown, model attribution, end-to-end rate and live streaming estimates", () => {
    const completed = parseThroughput({
      ...sample,
      model: "claude-opus-4-7",
      breakdown: { modelMs: 2_000, toolMs: 5_000, waitMs: 1_200, startupMs: 1_800, wallMs: 10_000 },
      outputTokens: 120,
      elapsedMs: 2_000,
    });
    expect(completed?.model).toBe("claude-opus-4-7");
    expect(averageTps(completed)).toBe(60);
    expect(endToEndTps(completed)).toBe(12);

    const running = parseThroughput({
      version: 1,
      source: "cursor",
      status: "running",
      outputTokens: null,
      elapsedMs: 1_500,
      generation: null,
      generationReason: "unsupported",
      liveEstimate: { outputTokens: 72, elapsedMs: 1_500, estimated: true },
    });
    expect(averageTps(running)).toBeNull();
    expect(liveEstimateTps(running)).toBe(48);
    expect(formatTps(48.4)).toBe("48");
    expect(formatTps(8.46)).toBe("8.5");
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
    for (const bad of [{ ...outputRate, samples: 1 }, { ...outputRate, outputTokens: 1 }, { ...outputRate, excludedSamples: -1 }, { ...outputRate, basis: "text_chunks" }]) {
      expect(parseThroughput({ ...sample, outputRate: bad })?.outputRate).toBeNull();
    }
    for (const reason of ["missing_baseline", "implausible", "insufficient_timing", "subagent_mixed"] as const) {
      expect(parseThroughput({ ...sample, turnReason: reason })?.turnReason).toBe(reason);
    }
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
