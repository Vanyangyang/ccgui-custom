import type { ThroughputStatsSnapshot, ThroughputTotals } from "@/lib/ipc";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ENGINES = ["claude", "codex", "agy", "cursor"];

function totals(value: unknown): ThroughputTotals | undefined {
  const raw = record(value);
  if (!raw || !count(raw.outputTokens) || !count(raw.completedTurns) || !count(raw.excludedTurns) ||
    typeof raw.elapsedMs !== "number" || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0) return;
  if (raw.completedTurns > 0 ? raw.elapsedMs <= 0 : raw.outputTokens !== 0 || raw.elapsedMs !== 0) return;
  const hasInterrupted = raw.interruptedTurns !== undefined && raw.interruptedTurns !== null;
  const hasMissing = raw.missingTurns !== undefined && raw.missingTurns !== null;
  if (hasInterrupted && !count(raw.interruptedTurns)) return;
  if (hasMissing && !count(raw.missingTurns)) return;
  const interruptedTurns = hasInterrupted ? (raw.interruptedTurns as number) : undefined;
  const missingTurns = hasMissing ? (raw.missingTurns as number) : undefined;
  if ((interruptedTurns ?? 0) + (missingTurns ?? 0) > raw.excludedTurns) return;
  const hasMedian = raw.medianTps !== undefined && raw.medianTps !== null;
  if (hasMedian && (typeof raw.medianTps !== "number" || !Number.isFinite(raw.medianTps) || raw.medianTps < 0)) return;
  const medianTps = hasMedian && raw.completedTurns > 0 ? (raw.medianTps as number) : undefined;
  return {
    outputTokens: raw.outputTokens,
    elapsedMs: raw.elapsedMs,
    completedTurns: raw.completedTurns,
    excludedTurns: raw.excludedTurns,
    ...(interruptedTurns !== undefined ? { interruptedTurns } : {}),
    ...(missingTurns !== undefined ? { missingTurns } : {}),
    ...(medianTps !== undefined ? { medianTps } : {}),
  };
}

export function parseThroughputStats(value: unknown): ThroughputStatsSnapshot | undefined {
  const raw = record(value);
  const global = totals(raw?.global);
  const session = totals(raw?.session);
  const groups = record(raw?.byEngine);
  if (!raw || !global || !session || !groups) return;
  const byEngine: Record<string, ThroughputTotals> = {};
  for (const [engine, entry] of Object.entries(groups)) {
    const parsed = totals(entry);
    if (!parsed || !ENGINES.includes(engine)) return;
    byEngine[engine] = parsed;
  }
  let byModel: Record<string, ThroughputTotals> | undefined;
  if (raw.byModel !== undefined && raw.byModel !== null) {
    const modelGroups = record(raw.byModel);
    if (!modelGroups) return;
    byModel = {};
    for (const [model, entry] of Object.entries(modelGroups)) {
      const trimmed = model.trim();
      const parsed = totals(entry);
      if (!trimmed || !parsed) return;
      byModel[trimmed] = parsed;
    }
  }
  const startedAt = typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) && raw.startedAt > 0 &&
    Number.isFinite(new Date(raw.startedAt).getTime()) ? raw.startedAt : undefined;
  return {
    global,
    session,
    byEngine,
    ...(byModel !== undefined ? { byModel } : {}),
    startedAt,
  };
}

/** Weighted by observed active model time, never an average of individual TPS values. */
export function aggregateTps(value: ThroughputTotals | undefined): number | null {
  const valid = totals(value);
  if (!valid || !valid.completedTurns || valid.outputTokens <= 0) return null;
  const rate = valid.outputTokens * 1000 / valid.elapsedMs;
  return Number.isFinite(rate) ? rate : null;
}
