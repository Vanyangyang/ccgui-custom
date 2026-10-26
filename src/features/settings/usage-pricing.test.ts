import { describe, expect, it } from "vitest";
import {
  buildQuotaWindowSpans,
  computeModelCost,
  computeQuotaInferences,
  resolveModelPricing,
  sumRowsCost,
} from "./usage-pricing";
import type { ClaudeQuotaSnapshot, CodexQuotaSnapshot, UsageWindowRow } from "@/lib/ipc";

describe("resolveModelPricing & computeModelCost", () => {
  it("treats Claude channel cache reads as free ($0 billed) while keeping reference API cache cost", () => {
    const pricing = resolveModelPricing("claude", "opus");
    expect(pricing.cacheReadFree).toBe(true);
    expect(pricing.inputUsdPerM).toBe(5);
    expect(pricing.cacheReadUsdPerM).toBe(0.5);

    const cost = computeModelCost("claude", "opus", {
      input: 100_000,
      output: 10_000,
      cacheRead: 1_000_000,
      cacheWrite: 100_000,
    });
    // input: 0.1M * $5 = $0.50
    // output: 0.01M * $25 = $0.25
    // cacheWrite: 0.1M * $6.25 = $0.625
    // cacheReadBilled: $0 (free on claude channel)
    // cacheReadRef: 1.0M * $0.50 = $0.50
    expect(cost.inputUsd).toBeCloseTo(0.5);
    expect(cost.outputUsd).toBeCloseTo(0.25);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.625);
    expect(cost.cacheReadBilledUsd).toBe(0);
    expect(cost.cacheReadRefUsd).toBeCloseTo(0.5);
    expect(cost.actualTotalUsd).toBeCloseTo(1.375);
    expect(cost.referenceTotalUsd).toBeCloseTo(1.875);
    expect(cost.cacheHitRate).toBeCloseTo((1_000_000 / 1_200_000) * 100);
  });

  it("bills cache reads at discounted rate on non-Claude channels (Codex / AGY)", () => {
    const codexCost = computeModelCost("codex", "gpt-6-astra", {
      input: 200_000,
      output: 20_000,
      cacheRead: 1_500_000,
      cacheWrite: 0,
    });
    // input: 0.2M * $2.50 = $0.50
    // output: 0.02M * $10 = $0.20
    // cacheRead: 1.5M * $0.25 = $0.375
    expect(codexCost.cacheReadBilledUsd).toBeCloseTo(0.375);
    expect(codexCost.actualTotalUsd).toBeCloseTo(1.075);
    expect(codexCost.savedUsd).toBeGreaterThan(3);

    const agyCost = computeModelCost("agy", "gemini-4-argon", {
      input: 300_000,
      output: 10_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
    });
    // input: 0.3M * $1.25 = $0.375
    // output: 0.01M * $10 = $0.10
    // cacheRead: 1.0M * $0.125 = $0.125
    expect(agyCost.cacheReadBilledUsd).toBeCloseTo(0.125);
    expect(agyCost.actualTotalUsd).toBeCloseTo(0.6);
  });

  it("sums rows across engines and preserves Claude free cache reference delta", () => {
    const summary = sumRowsCost([
      {
        engine: "claude",
        model: "opus",
        input: 100_000,
        output: 10_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      },
      {
        engine: "codex",
        model: "gpt-6-astra",
        input: 100_000,
        output: 10_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
      },
    ]);
    // Claude cacheRead billed = 0, ref = $0.50; Codex cacheRead billed = $0.25, ref = $0.25
    expect(summary.cacheReadBilledUsd).toBeCloseTo(0.25);
    expect(summary.cacheReadRefUsd).toBeCloseTo(0.75);
  });
});

describe("computeQuotaInferences", () => {
  const nowSec = 1_760_000_000;

  it("infers 5h and weekly (7d) USD limits from cache-adjusted spend and flags low-percentage uncertainty", () => {
    const claude: ClaudeQuotaSnapshot = {
      status: "ready",
      collectedAt: nowSec - 10,
      windows: {
        fiveHour: { usedPercentage: 2, resetsAt: nowSec + 3600 },
        sevenDay: { usedPercentage: 25, resetsAt: nowSec + 86400 * 3 },
      },
    };
    const codex: CodexQuotaSnapshot = {
      status: "ready",
      collectedAt: nowSec - 10,
      windows: {
        fiveHour: { usedPercentage: 20, resetsAt: nowSec + 7200 },
        sevenDay: { usedPercentage: 40, resetsAt: nowSec + 86400 * 4 },
      },
    };

    const spans = buildQuotaWindowSpans({ claude, codex }, nowSec);
    expect(spans.length).toBeGreaterThanOrEqual(4);

    const rows: UsageWindowRow[] = [
      {
        windowId: "claude:fiveHour",
        engine: "claude",
        model: "opus",
        input: 200_000, // $1.00
        output: 40_000, // $1.00
        cacheRead: 2_000_000, // $0 actual ($1.00 ref)
        cacheWrite: 0,
        requests: 3,
      },
      {
        windowId: "claude:sevenDay",
        engine: "claude",
        model: "opus",
        input: 2_000_000, // $10.00
        output: 600_000, // $15.00
        cacheRead: 10_000_000, // $0 actual ($5.00 ref)
        cacheWrite: 0,
        requests: 20,
      },
      {
        windowId: "codex:fiveHour",
        engine: "codex",
        model: "gpt-6-astra",
        input: 1_000_000, // $2.50
        output: 150_000, // $1.50
        cacheRead: 4_000_000, // $1.00
        cacheWrite: 0,
        requests: 5,
      },
      {
        windowId: "codex:sevenDay",
        engine: "codex",
        model: "gpt-6-astra",
        input: 4_000_000, // $10.00
        output: 600_000, // $6.00
        cacheRead: 16_000_000, // $4.00
        cacheWrite: 0,
        requests: 25,
      },
    ];

    const inferences = computeQuotaInferences(rows, { claude, codex }, nowSec);
    const claudeInf = inferences.find((i) => i.id === "claude")!;
    expect(claudeInf).toBeDefined();
    // 5h local spend = $2.00 at 2% -> inferred 5h limit = $100.00, low_percentage warning
    expect(claudeInf.fiveHour.localSpentUsd).toBeCloseTo(2);
    expect(claudeInf.fiveHour.cacheReadFreeRefUsd).toBeCloseTo(1);
    expect(claudeInf.fiveHour.inferredLimitUsd).toBeCloseTo(100);
    expect(claudeInf.fiveHour.confidence).toBe("low_percentage");

    // 7d local spend = $25.00 at 25% -> inferred 7d weekly limit = $100.00, normal confidence
    expect(claudeInf.sevenDay.localSpentUsd).toBeCloseTo(25);
    expect(claudeInf.sevenDay.inferredLimitUsd).toBeCloseTo(100);
    expect(claudeInf.sevenDay.confidence).toBe("normal");
    expect(claudeInf.weeklyLimitEstimateUsd).toBeCloseTo(100);
    expect(claudeInf.weeklyLimitSource).toBe("seven_day_direct");

    const codexInf = inferences.find((i) => i.id === "codex")!;
    // Codex 7d spend = $20.00 at 40% -> inferred 7d limit = $50.00
    expect(codexInf.sevenDay.localSpentUsd).toBeCloseTo(20);
    expect(codexInf.sevenDay.inferredLimitUsd).toBeCloseTo(50);
    expect(codexInf.weeklyLimitEstimateUsd).toBeCloseTo(50);
  });
});
