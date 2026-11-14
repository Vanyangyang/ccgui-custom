/** Host observations only. Never infer completed tokens or timing from message text/usage. */
export interface ThroughputBreakdown {
  modelMs: number;
  toolMs: number;
  waitMs: number;
  startupMs: number;
  wallMs: number;
}

export interface ThroughputLiveEstimate {
  outputTokens: number;
  elapsedMs: number;
  estimated: true;
}

export interface ThroughputSample {
  version: 1;
  source: "claude" | "codex_app_server" | "agy" | "cursor";
  status: "running" | "complete" | "partial";
  outputTokens: number | null;
  elapsedMs: number | null;
  generation: { outputTokens: number; elapsedMs: number } | null;
  generationReason: "reasoning" | "tools" | "non_streaming" | "missing_usage" | "insufficient_timing" | "ambiguous" | "unsupported" | "unavailable_timing" | null;
  /** Counter deltas paired with arrival intervals within completed model responses. */
  outputRate?: { basis: "usage_reports"; outputTokens: number; elapsedMs: number; samples: number; excludedSamples: number } | null;
  turnReason?: TurnExclusionReason | null;
  model?: string | null;
  breakdown?: ThroughputBreakdown | null;
  /** Ephemeral 1Hz streaming estimate while running; never persisted to ledger or summary. */
  liveEstimate?: ThroughputLiveEstimate | null;
}

export const TURN_EXCLUSION_REASONS = [
  "interrupted",
  "missing_usage",
  "missing_timing",
  "insufficient_timing",
  "implausible",
  "subagent_mixed",
  "missing_baseline",
  "counter_reset",
  "conflicting_usage",
  "missing_boundary",
  "pending_usage",
  "invalid_identity",
  "unsupported",
  "incomplete",
  "legacy_unknown",
] as const;
export type TurnExclusionReason = typeof TURN_EXCLUSION_REASONS[number];

export const MIN_COMPLETE_WINDOW_MS = 1_000;
export const MIN_RUNNING_WINDOW_MS = 500;
export const MAX_PLAUSIBLE_TPS = 1_000;

export interface ThroughputState {
  runId: string;
  seq: number;
  sample: ThroughputSample | null;
  /** A terminal boundary cannot be reopened by a delayed running sample. */
  ended: boolean;
}

const SOURCES = ["claude", "codex_app_server", "agy", "cursor"];
const REASONS = ["reasoning", "tools", "non_streaming", "missing_usage", "insufficient_timing", "ambiguous", "unsupported", "unavailable_timing"];
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonNegativeDuration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseBreakdown(value: unknown): ThroughputBreakdown | null {
  const raw = record(value);
  if (
    !raw ||
    !nonNegativeDuration(raw.modelMs) ||
    !nonNegativeDuration(raw.toolMs) ||
    !nonNegativeDuration(raw.waitMs) ||
    !nonNegativeDuration(raw.startupMs) ||
    !nonNegativeDuration(raw.wallMs)
  ) {
    return null;
  }
  return {
    modelMs: raw.modelMs,
    toolMs: raw.toolMs,
    waitMs: raw.waitMs,
    startupMs: raw.startupMs,
    wallMs: raw.wallMs,
  };
}

function parseLiveEstimate(value: unknown): ThroughputLiveEstimate | null {
  const raw = record(value);
  if (!raw || raw.estimated !== true || !tokens(raw.outputTokens) || !duration(raw.elapsedMs)) {
    return null;
  }
  return {
    outputTokens: raw.outputTokens,
    elapsedMs: raw.elapsedMs,
    estimated: true,
  };
}

export function parseThroughput(value: unknown): ThroughputSample | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || typeof raw.source !== "string" || !SOURCES.includes(raw.source) ||
    typeof raw.status !== "string" || !["running", "complete", "partial"].includes(raw.status) ||
    !(raw.generationReason === null || typeof raw.generationReason === "string" && REASONS.includes(raw.generationReason))) return null;
  // Invalid numbers become missing measurements; they never reach a rate.
  // Legacy first/last-text-chunk timing has no paired native token counts.
  const outputRate = parseOutputRate(raw.outputRate);
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
  const breakdown = parseBreakdown(raw.breakdown);
  const liveEstimate = parseLiveEstimate(raw.liveEstimate);
  return {
    version: 1,
    source: raw.source as ThroughputSample["source"],
    status: raw.status as ThroughputSample["status"],
    outputTokens: tokens(raw.outputTokens) ? raw.outputTokens : null,
    elapsedMs: duration(raw.elapsedMs) ? raw.elapsedMs : null,
    generation: null,
    generationReason: raw.generationReason as ThroughputSample["generationReason"] ?? "unavailable_timing",
    outputRate,
    turnReason: typeof raw.turnReason === "string" && TURN_EXCLUSION_REASONS.includes(raw.turnReason as TurnExclusionReason) ? raw.turnReason as TurnExclusionReason : null,
    ...(model ? { model } : {}),
    ...(breakdown ? { breakdown } : {}),
    ...(liveEstimate ? { liveEstimate } : {}),
  };
}

function rate(count: number, milliseconds: number): number | null {
  const value = count / (milliseconds / 1000);
  return Number.isFinite(value) ? value : null;
}

export function averageTps(sample: ThroughputSample | null | undefined): number | null {
  if (!sample || sample.status === "partial" || sample.turnReason != null) return null;
  if (!tokens(sample.outputTokens) || sample.outputTokens <= 0 || !duration(sample.elapsedMs)) return null;
  const minWindow = sample.status === "running" ? MIN_RUNNING_WINDOW_MS : MIN_COMPLETE_WINDOW_MS;
  if (sample.elapsedMs < minWindow) return null;
  const computed = rate(sample.outputTokens, sample.elapsedMs);
  return computed !== null && computed <= MAX_PLAUSIBLE_TPS ? computed : null;
}

export function liveEstimateTps(sample: ThroughputSample | null | undefined): number | null {
  if (!sample || sample.status !== "running") return null;
  const est = parseLiveEstimate(sample.liveEstimate);
  if (est && est.outputTokens > 0 && est.elapsedMs >= MIN_RUNNING_WINDOW_MS) {
    const computed = rate(est.outputTokens, est.elapsedMs);
    if (computed !== null && computed <= MAX_PLAUSIBLE_TPS) return computed;
  }
  return averageTps(sample);
}

export function endToEndTps(sample: ThroughputSample | null | undefined): number | null {
  if (!sample || sample.status !== "complete" || sample.turnReason != null) return null;
  const breakdown = parseBreakdown(sample.breakdown);
  if (!tokens(sample.outputTokens) || sample.outputTokens <= 0 || !breakdown || breakdown.wallMs < MIN_COMPLETE_WINDOW_MS) {
    return null;
  }
  const computed = rate(sample.outputTokens, breakdown.wallMs);
  return computed !== null && computed <= MAX_PLAUSIBLE_TPS ? computed : null;
}

function parseOutputRate(value: unknown): ThroughputSample["outputRate"] {
  const raw = record(value);
  if (!raw || raw.basis !== "usage_reports" || !tokens(raw.outputTokens) || !tokens(raw.samples) || !tokens(raw.excludedSamples) ||
    !(raw.samples > 0 ? duration(raw.elapsedMs) : raw.elapsedMs === 0 && raw.outputTokens === 0)) return null;
  return { basis: "usage_reports", outputTokens: raw.outputTokens, elapsedMs: raw.elapsedMs as number, samples: raw.samples, excludedSamples: raw.excludedSamples };
}

export function observedOutputTps(sample: ThroughputSample | null | undefined): number | null {
  const observed = parseOutputRate(sample?.outputRate);
  // A failed turn may still contain earlier, fully observed responses.
  if (!observed || observed.samples <= 0 || observed.outputTokens <= 0) return null;
  const computed = rate(observed.outputTokens, observed.elapsedMs);
  return computed !== null && computed <= MAX_PLAUSIBLE_TPS ? computed : null;
}

export function formatTps(value: number, locale?: string): string {
  const isSmall = value < 10;
  const rounded = isSmall ? Math.round(value * 10) / 10 : Math.round(value);
  if (locale) {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: isSmall ? 1 : 0,
    }).format(rounded);
  }
  return isSmall ? rounded.toFixed(Number.isInteger(rounded) ? 0 : 1) : String(rounded);
}

export function beginThroughput(runId: string, seq = -1): ThroughputState {
  return { runId, seq, sample: null, ended: false };
}

export function settleThroughput(state: ThroughputState | null | undefined, runId?: string, partial = false, seq?: number): ThroughputState | null {
  if (!state || (runId && state.runId !== runId) || (seq !== undefined && seq <= state.seq)) return state ?? null;
  return { ...state, seq: seq ?? state.seq, ended: true, sample: state.sample && (partial || state.sample.status === "running")
    ? { ...state.sample, status: "partial" } : state.sample };
}

export function updateThroughput(state: ThroughputState, runId: string, seq: number, sample: ThroughputSample): ThroughputState {
  if (state.runId !== runId || !Number.isSafeInteger(seq) || seq <= state.seq ||
    state.ended || state.sample?.status === "partial") return state;
  return { runId, seq, sample, ended: false };
}

/** Sender state owns the run; a native placeholder may own its newer sample. */
export function mergeThroughput(sender: ThroughputState | null | undefined, native: ThroughputState | null | undefined): ThroughputState | null {
  if (!sender) return native ?? null;
  if (!native || native.runId !== sender.runId || native.seq <= sender.seq) return sender;
  if (sender.ended) return sender;
  return { ...native, ended: sender.ended || native.ended };
}
