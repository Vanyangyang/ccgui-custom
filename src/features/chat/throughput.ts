/** Host observations only. Never infer tokens or timing from message text/usage. */
export interface ThroughputSample {
  version: 1;
  source: "claude" | "codex_app_server" | "agy";
  status: "running" | "complete" | "partial";
  outputTokens: number | null;
  elapsedMs: number | null;
  generation: { outputTokens: number; elapsedMs: number } | null;
  generationReason: "reasoning" | "tools" | "non_streaming" | "missing_usage" | "insufficient_timing" | "ambiguous" | "unsupported" | "unavailable_timing" | null;
  /** Counter deltas paired with arrival intervals within completed model responses. */
  outputRate?: { basis: "usage_reports"; outputTokens: number; elapsedMs: number; samples: number; excludedSamples: number } | null;
  turnReason?: TurnExclusionReason | null;
}

export const TURN_EXCLUSION_REASONS = ["interrupted", "missing_usage", "missing_timing", "missing_baseline", "counter_reset", "conflicting_usage", "missing_boundary", "pending_usage", "invalid_identity", "unsupported", "incomplete", "legacy_unknown"] as const;
export type TurnExclusionReason = typeof TURN_EXCLUSION_REASONS[number];

export interface ThroughputState {
  runId: string;
  seq: number;
  sample: ThroughputSample | null;
  /** A terminal boundary cannot be reopened by a delayed running sample. */
  ended: boolean;
}

const REASONS = ["reasoning", "tools", "non_streaming", "missing_usage", "insufficient_timing", "ambiguous", "unsupported", "unavailable_timing"];
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function parseThroughput(value: unknown): ThroughputSample | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || typeof raw.source !== "string" || !["claude", "codex_app_server", "agy"].includes(raw.source) ||
    typeof raw.status !== "string" || !["running", "complete", "partial"].includes(raw.status) ||
    !(raw.generationReason === null || typeof raw.generationReason === "string" && REASONS.includes(raw.generationReason))) return null;
  // Invalid numbers become missing measurements; they never reach a rate.
  // Legacy first/last-text-chunk timing has no paired native token counts.
  const outputRate = parseOutputRate(raw.outputRate);
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
  };
}

function rate(count: number, milliseconds: number): number | null {
  const value = count / (milliseconds / 1000);
  return Number.isFinite(value) ? value : null;
}

export function averageTps(sample: ThroughputSample | null | undefined): number | null {
  return sample && sample.status !== "partial" && tokens(sample.outputTokens) && duration(sample.elapsedMs)
    ? rate(sample.outputTokens, sample.elapsedMs) : null;
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
  return observed && observed.samples > 0 ? rate(observed.outputTokens, observed.elapsedMs) : null;
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
