import type { ThroughputStatsSnapshot, ThroughputTotals } from "@/lib/ipc";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function totals(value: unknown): ThroughputTotals | undefined {
  const raw = record(value);
  if (!raw || !count(raw.outputTokens) || !count(raw.completedTurns) || !count(raw.excludedTurns) ||
    typeof raw.elapsedMs !== "number" || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0) return;
  if (raw.completedTurns > 0 ? raw.elapsedMs <= 0 : raw.outputTokens !== 0 || raw.elapsedMs !== 0) return;
  return { outputTokens: raw.outputTokens, elapsedMs: raw.elapsedMs, completedTurns: raw.completedTurns, excludedTurns: raw.excludedTurns };
}

export function parseThroughputStats(value: unknown): ThroughputStatsSnapshot | undefined {
  const raw = record(value);
  const global = totals(raw?.global);
  const session = totals(raw?.session);
  const groups = record(raw?.byEngine);
  if (!raw || !global || !session || !groups) return;
  const byEngine: Record<string, ThroughputTotals> = {};
  for (const [engine, value] of Object.entries(groups)) {
    const parsed = totals(value);
    if (!parsed || !["claude", "codex", "agy"].includes(engine)) return;
    byEngine[engine] = parsed;
  }
  const startedAt = typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) && raw.startedAt > 0 &&
    Number.isFinite(new Date(raw.startedAt).getTime()) ? raw.startedAt : undefined;
  return { global, session, byEngine, startedAt };
}

/** Weighted by observed time, never an average of individual TPS values. */
export function aggregateTps(value: ThroughputTotals | undefined): number | null {
  const valid = totals(value);
  if (!valid || !valid.completedTurns) return null;
  const rate = valid.outputTokens * 1000 / valid.elapsedMs;
  return Number.isFinite(rate) ? rate : null;
}
