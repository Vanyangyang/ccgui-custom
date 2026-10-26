import { agyQuotaModelGroup } from "@/features/chat/agy-quota";
import type {
  AgyQuotaSnapshot,
  ClaudeQuotaSnapshot,
  CodexQuotaSnapshot,
  UsageWindowRow,
  UsageWindowSpan,
} from "@/lib/ipc";
import { modelDisplayName } from "./usage-model";
import type { TokenParts } from "./usage-totals";

/**
 * Per-million-token USD pricing for a model family.
 *
 * `cacheReadUsdPerM` is the standard API cache-read rate (e.g. 0.1x input for
 * Anthropic/Gemini, 0.1x–0.25x for OpenAI).
 * For the Claude Code channel (`engine === "claude"`), cache reads are billed
 * at $0 in actual usage while the standard API cache-read value (`cacheReadRefUsd`)
 * is kept so the UI can display `$0.00 ($X.XX)` in parentheses as requested.
 */
export interface ModelPricing {
  inputUsdPerM: number;
  outputUsdPerM: number;
  cacheReadUsdPerM: number;
  cacheWriteUsdPerM: number;
  /** True when the engine's channel makes cache reads free ($0 actual cost). */
  cacheReadFree: boolean;
}

export interface CostBreakdown {
  /** Fresh non-cached input cost in USD. */
  inputUsd: number;
  /** Output token cost in USD. */
  outputUsd: number;
  /** Actual billed cache-read cost in USD ($0 on Claude channel). */
  cacheReadBilledUsd: number;
  /** Reference API cache-read cost in USD (shown in parentheses when free). */
  cacheReadRefUsd: number;
  /** Full-input equivalent of `cacheRead` tokens if they had missed cache. */
  cacheReadFullInputUsd: number;
  /** Cache creation/write cost in USD. */
  cacheWriteUsd: number;
  /** Actual total USD cost (`input + output + cacheReadBilled + cacheWrite`). */
  actualTotalUsd: number;
  /** Reference API total USD cost (`input + output + cacheReadRef + cacheWrite`). */
  referenceTotalUsd: number;
  /** Uncached baseline USD cost if all prompt tokens were billed as fresh input. */
  uncachedTotalUsd: number;
  /** USD saved by cache hits compared to fresh input (`max(0, uncachedTotalUsd - actualTotalUsd)`). */
  savedUsd: number;
  /** Prompt token total (`input + cacheRead + cacheWrite`). */
  promptTokens: number;
  /** Cache hit ratio in `[0, 100]` (`cacheRead / promptTokens * 100`), or `null` when `promptTokens === 0`. */
  cacheHitRate: number | null;
}

const MILLION = 1_000_000;

/**
 * Resolve per-1M token pricing for `(engine, model)`.
 */
export function resolveModelPricing(engine: string, model: string): ModelPricing {
  const clean = modelDisplayName(model).toLowerCase();
  const isClaudeChannel = engine === "claude";

  // Anthropic Claude family
  if (clean.includes("opus")) {
    // Claude 4.5 / 4.6 / 5.x Opus ($5 / $25, cache read $0.50, write $6.25);
    // legacy Claude 3 / 4.0 / 4.1 Opus ($15 / $75)
    const legacy = /opus-(3|4-0|4-1|4\.0|4\.1|2024)/.test(clean);
    const input = legacy ? 15 : 5;
    const output = legacy ? 75 : 25;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.1,
      cacheWriteUsdPerM: input * 1.25,
      cacheReadFree: isClaudeChannel,
    };
  }
  if (clean.includes("haiku")) {
    const input = 1;
    const output = 5;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.1,
      cacheWriteUsdPerM: input * 1.25,
      cacheReadFree: isClaudeChannel,
    };
  }
  if (clean.includes("sonnet") || clean.includes("claude")) {
    const input = 3;
    const output = 15;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.1,
      cacheWriteUsdPerM: input * 1.25,
      cacheReadFree: isClaudeChannel,
    };
  }

  // Google Gemini / Antigravity family (gemini-4-argon, gemini-3.x, gemini-2.5)
  if (clean.includes("gemini") || clean.includes("argon")) {
    const isFlash = clean.includes("flash");
    const input = isFlash ? 0.3 : 1.25;
    const output = isFlash ? 2.5 : 10;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.1,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }

  // OpenAI / Codex family (gpt-6-astra, gpt-6-sol, gpt-5.x, codex, o1/o3/o4)
  if (clean.includes("mini") || clean.includes("nano")) {
    const input = 0.4;
    const output = 1.6;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.1,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }
  if (
    clean.includes("gpt-6") ||
    clean.includes("gpt-5") ||
    clean.includes("codex") ||
    clean.includes("astra") ||
    clean.includes("sol") ||
    /\bo[134]\b/.test(clean)
  ) {
    const input = 2.5;
    const output = 10;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.1,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }
  if (clean.includes("gpt-4")) {
    const input = 2.5;
    const output = 10;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: input * 0.25,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }

  // DeepSeek / Kimi / GLM / Qwen / Grok
  if (clean.includes("deepseek")) {
    const input = 0.28;
    const output = 0.42;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: 0.028,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }
  if (clean.includes("kimi") || clean.includes("moonshot")) {
    const input = 0.6;
    const output = 2.5;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: 0.15,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }
  if (clean.includes("grok")) {
    const input = 3;
    const output = 15;
    return {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cacheReadUsdPerM: 0.75,
      cacheWriteUsdPerM: input,
      cacheReadFree: isClaudeChannel,
    };
  }

  // Fallback by engine
  if (isClaudeChannel) {
    return {
      inputUsdPerM: 3,
      outputUsdPerM: 15,
      cacheReadUsdPerM: 0.3,
      cacheWriteUsdPerM: 3.75,
      cacheReadFree: true,
    };
  }
  if (engine === "codex") {
    return {
      inputUsdPerM: 2.5,
      outputUsdPerM: 10,
      cacheReadUsdPerM: 0.25,
      cacheWriteUsdPerM: 2.5,
      cacheReadFree: false,
    };
  }
  if (engine === "agy") {
    return {
      inputUsdPerM: 1.25,
      outputUsdPerM: 10,
      cacheReadUsdPerM: 0.125,
      cacheWriteUsdPerM: 1.25,
      cacheReadFree: false,
    };
  }
  return {
    inputUsdPerM: 2,
    outputUsdPerM: 8,
    cacheReadUsdPerM: 0.2,
    cacheWriteUsdPerM: 2,
    cacheReadFree: false,
  };
}

export const emptyCostBreakdown = (): CostBreakdown => ({
  inputUsd: 0,
  outputUsd: 0,
  cacheReadBilledUsd: 0,
  cacheReadRefUsd: 0,
  cacheReadFullInputUsd: 0,
  cacheWriteUsd: 0,
  actualTotalUsd: 0,
  referenceTotalUsd: 0,
  uncachedTotalUsd: 0,
  savedUsd: 0,
  promptTokens: 0,
  cacheHitRate: null,
});

export function computeModelCost(
  engine: string,
  model: string,
  parts: TokenParts,
): CostBreakdown {
  const pricing = resolveModelPricing(engine, model);
  const inputUsd = (parts.input / MILLION) * pricing.inputUsdPerM;
  const outputUsd = (parts.output / MILLION) * pricing.outputUsdPerM;
  const cacheReadRefUsd = (parts.cacheRead / MILLION) * pricing.cacheReadUsdPerM;
  const cacheReadBilledUsd = pricing.cacheReadFree ? 0 : cacheReadRefUsd;
  const cacheReadFullInputUsd = (parts.cacheRead / MILLION) * pricing.inputUsdPerM;
  const cacheWriteUsd = (parts.cacheWrite / MILLION) * pricing.cacheWriteUsdPerM;

  const actualTotalUsd = inputUsd + outputUsd + cacheReadBilledUsd + cacheWriteUsd;
  const referenceTotalUsd = inputUsd + outputUsd + cacheReadRefUsd + cacheWriteUsd;
  const promptTokens = parts.input + parts.cacheRead + parts.cacheWrite;
  const uncachedTotalUsd = (promptTokens / MILLION) * pricing.inputUsdPerM + outputUsd;
  const savedUsd = Math.max(0, uncachedTotalUsd - actualTotalUsd);
  const cacheHitRate = promptTokens > 0 ? (parts.cacheRead / promptTokens) * 100 : null;

  return {
    inputUsd,
    outputUsd,
    cacheReadBilledUsd,
    cacheReadRefUsd,
    cacheReadFullInputUsd,
    cacheWriteUsd,
    actualTotalUsd,
    referenceTotalUsd,
    uncachedTotalUsd,
    savedUsd,
    promptTokens,
    cacheHitRate,
  };
}

export function addCostBreakdowns(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const promptTokens = a.promptTokens + b.promptTokens;
  const inputUsd = a.inputUsd + b.inputUsd;
  const outputUsd = a.outputUsd + b.outputUsd;
  const cacheReadBilledUsd = a.cacheReadBilledUsd + b.cacheReadBilledUsd;
  const cacheReadRefUsd = a.cacheReadRefUsd + b.cacheReadRefUsd;
  const cacheReadFullInputUsd = a.cacheReadFullInputUsd + b.cacheReadFullInputUsd;
  const cacheWriteUsd = a.cacheWriteUsd + b.cacheWriteUsd;
  const actualTotalUsd = a.actualTotalUsd + b.actualTotalUsd;
  const referenceTotalUsd = a.referenceTotalUsd + b.referenceTotalUsd;
  const uncachedTotalUsd = a.uncachedTotalUsd + b.uncachedTotalUsd;
  const savedUsd = Math.max(0, uncachedTotalUsd - actualTotalUsd);

  return {
    inputUsd,
    outputUsd,
    cacheReadBilledUsd,
    cacheReadRefUsd,
    cacheReadFullInputUsd,
    cacheWriteUsd,
    actualTotalUsd,
    referenceTotalUsd,
    uncachedTotalUsd,
    savedUsd,
    promptTokens,
    cacheHitRate: null,
  };
}

export function sumRowsCost(
  rows: ReadonlyArray<TokenParts & { engine: string; model: string }>,
): CostBreakdown & { totalCacheRead: number; totalCacheWrite: number; totalInput: number; totalOutput: number } {
  let acc = emptyCostBreakdown();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  for (const row of rows) {
    totalInput += row.input;
    totalOutput += row.output;
    totalCacheRead += row.cacheRead;
    totalCacheWrite += row.cacheWrite;
    acc = addCostBreakdowns(acc, computeModelCost(row.engine, row.model, row));
  }
  const promptTokens = totalInput + totalCacheRead + totalCacheWrite;
  return {
    ...acc,
    promptTokens,
    cacheHitRate: promptTokens > 0 ? (totalCacheRead / promptTokens) * 100 : null,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
  };
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  const cents = Math.round((usd + Number.EPSILON) * 100) / 100;
  if (cents < 100) return "$" + cents.toFixed(2);
  return "$" + Math.round(usd).toLocaleString("en-US");
}

export function formatPercent(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(digits)}%`;
}

// ==================== Quota Window Reverse Inference ====================

export const FIVE_HOUR_SECONDS = 5 * 3600;
export const SEVEN_DAY_SECONDS = 7 * 24 * 3600;
export const LOW_USAGE_PERCENT_THRESHOLD = 5;

export type InferredConfidence = "normal" | "low_percentage" | "no_local_spend" | "no_quota";

export interface WindowQuotaInference {
  windowType: "fiveHour" | "sevenDay";
  usedPercentage?: number;
  resetsAt?: number;
  sinceMs: number;
  untilMs: number;
  elapsedHours: number;
  localSpentUsd: number;
  localReferenceUsd: number;
  localSavedUsd: number;
  cacheReadTokens: number;
  cacheReadFreeRefUsd: number;
  cacheHitRate: number | null;
  /** Inferred 100% window limit in USD (`localSpentUsd / (usedPercentage / 100)`).
   *  Because local ledger only captures this client's turns, cross-client usage
   *  makes this a lower-bound estimate. */
  inferredLimitUsd: number | null;
  /** Inferred remaining USD in this window (`inferredLimitUsd - localSpentUsd`). */
  inferredRemainingUsd: number | null;
  /** Sensitivity range when `usedPercentage` has ±0.5% rounding uncertainty. */
  inferredLimitRangeUsd: { low: number; high: number } | null;
  /** Hourly burn rate in this window (`localSpentUsd / elapsedHours`). */
  hourlyRateUsd: number | null;
  confidence: InferredConfidence;
}

export interface EngineQuotaInference {
  id: string;
  engine: "claude" | "codex" | "agy";
  groupId?: "gemini" | "third_party";
  fiveHour: WindowQuotaInference;
  sevenDay: WindowQuotaInference;
  /** Primary inferred weekly limit (prefers 7d window direct inference; falls
   *  back to 5h rate projection when 7d percentage is unavailable). */
  weeklyLimitEstimateUsd: number | null;
  weeklyLimitSource: "seven_day_direct" | "five_hour_projected" | "hourly_rate_projected" | "none";
}

function windowBoundsMs(
  windowType: "fiveHour" | "sevenDay",
  resetsAt: number | undefined,
  nowSec: number,
): { sinceMs: number; untilMs: number; elapsedHours: number } {
  const durationSec = windowType === "fiveHour" ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS;
  const untilMs = Math.round(nowSec * 1000);
  if (resetsAt && Number.isFinite(resetsAt) && resetsAt > nowSec) {
    const startSec = Math.max(0, resetsAt - durationSec);
    const elapsedSec = Math.max(60, nowSec - startSec);
    return {
      sinceMs: Math.round(startSec * 1000),
      untilMs,
      elapsedHours: elapsedSec / 3600,
    };
  }
  return {
    sinceMs: Math.round((nowSec - durationSec) * 1000),
    untilMs,
    elapsedHours: durationSec / 3600,
  };
}

export function buildQuotaWindowSpans(
  snapshots: {
    claude?: ClaudeQuotaSnapshot;
    codex?: CodexQuotaSnapshot;
    agy?: AgyQuotaSnapshot;
  },
  nowSec = Date.now() / 1000,
): UsageWindowSpan[] {
  const spans: UsageWindowSpan[] = [];
  const pushPair = (prefix: string, windows?: ClaudeQuotaSnapshot["windows"]) => {
    for (const wt of ["fiveHour", "sevenDay"] as const) {
      const bounds = windowBoundsMs(wt, windows?.[wt]?.resetsAt, nowSec);
      spans.push({
        id: `${prefix}:${wt}`,
        sinceMs: bounds.sinceMs,
        untilMs: bounds.untilMs,
      });
    }
  };
  pushPair("claude", snapshots.claude?.windows);
  pushPair("codex", snapshots.codex?.windows);
  for (const groupId of ["gemini", "third_party"] as const) {
    const group = snapshots.agy?.groups.find((g) => g.id === groupId);
    pushPair(`agy:${groupId}`, group?.windows);
  }
  return spans;
}

function inferSingleWindow(
  windowType: "fiveHour" | "sevenDay",
  quotaWindow: { usedPercentage: number; resetsAt?: number } | undefined,
  rows: UsageWindowRow[],
  nowSec: number,
): WindowQuotaInference {
  const bounds = windowBoundsMs(windowType, quotaWindow?.resetsAt, nowSec);
  const cost = sumRowsCost(rows);
  const localSpentUsd = cost.actualTotalUsd;
  const localReferenceUsd = cost.referenceTotalUsd;
  const localSavedUsd = cost.savedUsd;
  const cacheReadFreeRefUsd = Math.max(0, cost.cacheReadRefUsd - cost.cacheReadBilledUsd);
  const hourlyRateUsd = bounds.elapsedHours > 0 ? localSpentUsd / bounds.elapsedHours : null;

  const usedPct = quotaWindow?.usedPercentage;
  if (usedPct === undefined || !Number.isFinite(usedPct) || usedPct <= 0) {
    return {
      windowType,
      usedPercentage: usedPct,
      resetsAt: quotaWindow?.resetsAt,
      sinceMs: bounds.sinceMs,
      untilMs: bounds.untilMs,
      elapsedHours: bounds.elapsedHours,
      localSpentUsd,
      localReferenceUsd,
      localSavedUsd,
      cacheReadTokens: cost.totalCacheRead,
      cacheReadFreeRefUsd,
      cacheHitRate: cost.cacheHitRate,
      inferredLimitUsd: null,
      inferredRemainingUsd: null,
      inferredLimitRangeUsd: null,
      hourlyRateUsd,
      confidence: "no_quota",
    };
  }

  if (localSpentUsd <= 0) {
    return {
      windowType,
      usedPercentage: usedPct,
      resetsAt: quotaWindow?.resetsAt,
      sinceMs: bounds.sinceMs,
      untilMs: bounds.untilMs,
      elapsedHours: bounds.elapsedHours,
      localSpentUsd,
      localReferenceUsd,
      localSavedUsd,
      cacheReadTokens: cost.totalCacheRead,
      cacheReadFreeRefUsd,
      cacheHitRate: cost.cacheHitRate,
      inferredLimitUsd: null,
      inferredRemainingUsd: null,
      inferredLimitRangeUsd: null,
      hourlyRateUsd: 0,
      confidence: "no_local_spend",
    };
  }

  const inferredLimitUsd = localSpentUsd / (usedPct / 100);
  const inferredRemainingUsd = Math.max(0, inferredLimitUsd - localSpentUsd);
  const lowPct = Math.max(0.25, usedPct - 0.5);
  const highPct = Math.min(100, usedPct + 0.5);
  const inferredLimitRangeUsd = {
    low: localSpentUsd / (highPct / 100),
    high: localSpentUsd / (lowPct / 100),
  };

  return {
    windowType,
    usedPercentage: usedPct,
    resetsAt: quotaWindow?.resetsAt,
    sinceMs: bounds.sinceMs,
    untilMs: bounds.untilMs,
    elapsedHours: bounds.elapsedHours,
    localSpentUsd,
    localReferenceUsd,
    localSavedUsd,
    cacheReadTokens: cost.totalCacheRead,
    cacheReadFreeRefUsd,
    cacheHitRate: cost.cacheHitRate,
    inferredLimitUsd,
    inferredRemainingUsd,
    inferredLimitRangeUsd,
    hourlyRateUsd,
    confidence: usedPct < LOW_USAGE_PERCENT_THRESHOLD ? "low_percentage" : "normal",
  };
}

function matchesEngineAndGroup(
  row: UsageWindowRow,
  engine: "claude" | "codex" | "agy",
  groupId?: "gemini" | "third_party",
): boolean {
  if (row.engine !== engine) return false;
  if (engine !== "agy" || !groupId) return true;
  const resolved = agyQuotaModelGroup(modelDisplayName(row.model));
  if (resolved) return resolved === groupId;
  return groupId === "gemini";
}

export function computeQuotaInferences(
  windowRows: UsageWindowRow[],
  snapshots: {
    claude?: ClaudeQuotaSnapshot;
    codex?: CodexQuotaSnapshot;
    agy?: AgyQuotaSnapshot;
  },
  nowSec = Date.now() / 1000,
): EngineQuotaInference[] {
  const results: EngineQuotaInference[] = [];

  const buildOne = (
    id: string,
    engine: "claude" | "codex" | "agy",
    windows: ClaudeQuotaSnapshot["windows"] | undefined,
    groupId?: "gemini" | "third_party",
  ): EngineQuotaInference | null => {
    const rows5h = windowRows.filter(
      (r) => r.windowId === `${id}:fiveHour` && matchesEngineAndGroup(r, engine, groupId),
    );
    const rows7d = windowRows.filter(
      (r) => r.windowId === `${id}:sevenDay` && matchesEngineAndGroup(r, engine, groupId),
    );
    const fiveHour = inferSingleWindow("fiveHour", windows?.fiveHour, rows5h, nowSec);
    const sevenDay = inferSingleWindow("sevenDay", windows?.sevenDay, rows7d, nowSec);

    const hasAnyQuota =
      fiveHour.usedPercentage !== undefined || sevenDay.usedPercentage !== undefined;
    const hasAnySpend = fiveHour.localSpentUsd > 0 || sevenDay.localSpentUsd > 0;
    if (!hasAnyQuota && !hasAnySpend) return null;

    let weeklyLimitEstimateUsd: number | null = null;
    let weeklyLimitSource: EngineQuotaInference["weeklyLimitSource"] = "none";

    if (sevenDay.inferredLimitUsd !== null) {
      weeklyLimitEstimateUsd = sevenDay.inferredLimitUsd;
      weeklyLimitSource = "seven_day_direct";
    } else if (
      fiveHour.inferredLimitUsd !== null &&
      fiveHour.usedPercentage !== undefined &&
      sevenDay.usedPercentage !== undefined &&
      sevenDay.usedPercentage > 0
    ) {
      // Cross-window ratio when 7d spend hasn't been fully captured but 5h is known
      weeklyLimitEstimateUsd =
        fiveHour.inferredLimitUsd * (fiveHour.usedPercentage / sevenDay.usedPercentage);
      weeklyLimitSource = "five_hour_projected";
    } else if (fiveHour.hourlyRateUsd && fiveHour.hourlyRateUsd > 0) {
      weeklyLimitEstimateUsd = fiveHour.hourlyRateUsd * 168;
      weeklyLimitSource = "hourly_rate_projected";
    } else if (sevenDay.hourlyRateUsd && sevenDay.hourlyRateUsd > 0) {
      weeklyLimitEstimateUsd = sevenDay.hourlyRateUsd * 168;
      weeklyLimitSource = "hourly_rate_projected";
    }

    return {
      id,
      engine,
      groupId,
      fiveHour,
      sevenDay,
      weeklyLimitEstimateUsd,
      weeklyLimitSource,
    };
  };

  const claudeInf = buildOne("claude", "claude", snapshots.claude?.windows);
  if (claudeInf) results.push(claudeInf);

  const codexInf = buildOne("codex", "codex", snapshots.codex?.windows);
  if (codexInf) results.push(codexInf);

  for (const groupId of ["gemini", "third_party"] as const) {
    const group = snapshots.agy?.groups.find((g) => g.id === groupId);
    const agyInf = buildOne(`agy:${groupId}`, "agy", group?.windows, groupId);
    if (agyInf) results.push(agyInf);
  }

  return results;
}
