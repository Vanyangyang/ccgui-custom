/**
 * Cross-session memory for the context gauge's denominator.
 *
 * A model's real window only ever arrives with an engine report — for claude
 * that is the `modelUsage` map on a turn's result line — so a brand-new
 * session has nothing to show and the gauge falls back to the 200k guess
 * until its first turn ends. Remembering the last reported window per
 * engine+model slot lets the next session start at the right scale.
 *
 * localStorage-backed and best effort: a missing or throwing storage just
 * means the gauge keeps its old fallback behaviour.
 */
import { ASSUMED_CONTEXT_WINDOW, reportedContextWindow } from "./usage";

const PREFIX = "ccgui.context-window";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function cacheKey(engine: string, model: string | null | undefined): string {
  return `${PREFIX}.${engine}.${model || "default"}`;
}

/** Record the window an engine just reported for this engine+model slot. */
export function rememberContextWindow(
  engine: string,
  model: string | null | undefined,
  window: number,
): void {
  if (!engine || !Number.isFinite(window) || !(window > 0)) return;
  try {
    storage()?.setItem(cacheKey(engine, model), String(window));
  } catch {
    // Private mode / quota: the gauge just falls back to its old guess.
  }
}

/** The last window this engine+model slot reported, if any. */
export function recallContextWindow(
  engine: string,
  model: string | null | undefined,
): number | undefined {
  if (!engine) return undefined;
  try {
    const raw = storage()?.getItem(cacheKey(engine, model));
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Published capacity for the explicitly mounted API model, not AGY's
 * subscription aliases or a claim about current CLI occupancy.
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/get-started-with-gemini-4
 * Verified 2026-10-16: the 1,048,576 tokens are shared by input and output. */
function publishedApiWindow(engine: string, model?: string | null): number | undefined {
  return engine === "agy" && model === "gemini-4-argon" ? 1_048_576 : undefined;
}

/** A live report wins, then memory, the catalog, documented API capacity,
 * and finally the shared last-resort guess. */
export function resolveContextMaxInfo(opts: {
  usage: unknown;
  engine: string;
  model?: string | null;
  catalogWindow?: number | null;
}): { max: number; known: boolean } {
  const knownMax =
    reportedContextWindow(opts.usage) ||
    recallContextWindow(opts.engine, opts.model) ||
    (Number.isFinite(opts.catalogWindow) && (opts.catalogWindow ?? 0) > 0 ? opts.catalogWindow : undefined) ||
    publishedApiWindow(opts.engine, opts.model);
  return { max: knownMax ?? ASSUMED_CONTEXT_WINDOW, known: knownMax !== undefined };
}

export function resolveContextMax(opts: Parameters<typeof resolveContextMaxInfo>[0]): number {
  return resolveContextMaxInfo(opts).max;
}
