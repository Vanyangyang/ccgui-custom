import { parseUsage, reportedContextWindow } from "../usage";
import { usageBreakdown } from "./usage-breakdown";

export const AGY_REFERENCE_WINDOW_MIN = 100_000;
export const AGY_REFERENCE_WINDOW_MAX = 2_000_000;
export const AGY_REFERENCE_WINDOW_KEY = "ccgui.agy.reference-context-window";
export const AGY_REFERENCE_WINDOW_EVENT = "ccgui:agy-reference-context-window";

export function validAgyReferenceWindow(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= AGY_REFERENCE_WINDOW_MIN
    && value <= AGY_REFERENCE_WINDOW_MAX
    ? value
    : undefined;
}

export function readAgyReferenceWindow(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(AGY_REFERENCE_WINDOW_KEY);
    if (raw === null || raw === undefined || !raw.trim()) return undefined;
    return validAgyReferenceWindow(Number(raw));
  } catch {
    return undefined;
  }
}

export function writeAgyReferenceWindow(tokens?: number): void {
  const valid = tokens === undefined ? undefined : validAgyReferenceWindow(tokens);
  if (tokens !== undefined && valid === undefined) {
    throw new Error("invalid agy reference context window");
  }
  try {
    if (valid === undefined) globalThis.localStorage?.removeItem(AGY_REFERENCE_WINDOW_KEY);
    else globalThis.localStorage?.setItem(AGY_REFERENCE_WINDOW_KEY, String(valid));
  } catch {
    throw new Error("storage unavailable");
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AGY_REFERENCE_WINDOW_EVENT));
  }
}

/** Billing totals never stand in for a measured model request or occupancy. */
export function selectAgyContext(usage: unknown, referenceWindow?: number, modelWindow?: number) {
  const raw = usage && typeof usage === "object" ? usage as Record<string, unknown> : null;
  const kind = raw?.context_usage_kind;
  const contextUsage = kind === "last_prompt" || kind === "current_context" ? raw?.context_usage : null;
  const parsed = parseUsage(contextUsage);
  const reportedMax = reportedContextWindow(contextUsage) ?? reportedContextWindow(usage) ?? reportedContextWindow(raw?.session_usage);
  const referenceMax = validAgyReferenceWindow(referenceWindow);
  const knownModelMax = typeof modelWindow === "number" && Number.isSafeInteger(modelWindow) && modelWindow > 0 ? modelWindow : undefined;
  const max = reportedMax ?? referenceMax ?? knownModelMax;
  const usingReference = reportedMax === undefined && referenceMax !== undefined;
  const occupancyKnown = parsed !== null && (kind === "current_context" || (kind === "last_prompt" && usingReference));
  const breakdown = parsed ? usageBreakdown(contextUsage, max ?? 1) : null;
  return {
    max,
    reportedMax,
    capacityKnown: max !== undefined,
    occupancyKnown,
    countsKnown: parsed !== null,
    labelKey: kind === "last_prompt" ? "chat.agyLatestModelRequest" : "chat.contextWindow",
    noteKey: usingReference
      ? "chat.agyReferenceWindowNote"
      : occupancyKnown ? undefined : kind === "last_prompt" && parsed
        ? "chat.agyLatestModelRequestNote" : "chat.agyContextUnreported",
    parts: breakdown?.parts ?? [],
    total: parsed?.total,
    pct: occupancyKnown && max !== undefined ? breakdown?.pct : undefined,
  };
}
