import { hasAcpContextUsage, parseUsage, reportedContextWindow } from "../usage";
import { usageBreakdown } from "./usage-breakdown";

/** Billing totals never stand in for a measured model request or occupancy. */
export function selectAgyContext(usage: unknown, modelWindow?: number) {
  const raw = usage && typeof usage === "object" ? usage as Record<string, unknown> : null;
  const kind = raw?.context_usage_kind;
  const contextUsage = kind === "last_prompt" || kind === "current_context" ? raw?.context_usage : null;
  const parsed = parseUsage(contextUsage);
  const officialContext = hasAcpContextUsage(usage);
  const emptyOfficialContext = officialContext && parsed === null;
  const countsKnown = parsed !== null || emptyOfficialContext;
  const reportedMax = reportedContextWindow(contextUsage) ?? reportedContextWindow(usage) ?? reportedContextWindow(raw?.session_usage);
  const knownModelMax = typeof modelWindow === "number" && Number.isSafeInteger(modelWindow) && modelWindow > 0 ? modelWindow : undefined;
  const max = reportedMax ?? knownModelMax;
  const occupancyKnown = countsKnown && kind === "current_context";
  const breakdown = parsed ? usageBreakdown(contextUsage, max ?? 1) : null;
  return {
    max,
    reportedMax,
    capacityKnown: max !== undefined,
    occupancyKnown,
    countsKnown,
    labelKey: kind === "last_prompt" ? "chat.agyLatestModelRequest" : "chat.contextWindow",
    noteKey: occupancyKnown ? undefined : kind === "last_prompt" && parsed
        ? "chat.agyLatestModelRequestNote" : "chat.agyContextUnreported",
    parts: officialContext
      ? (parsed?.total ? [{ kind: "total" as const, tokens: parsed.total }] : [])
      : breakdown?.parts ?? [],
    total: emptyOfficialContext ? 0 : parsed?.total,
    pct: occupancyKnown && max !== undefined ? (emptyOfficialContext ? 0 : breakdown?.pct) : undefined,
  };
}
