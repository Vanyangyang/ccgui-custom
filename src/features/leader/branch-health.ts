import { resolveContextMaxInfo } from "@/features/chat/context-window-memory";
import { contextDisplayMax } from "@/features/chat/claude-context-window";
import { mergeUsage, parseUsage, reportedContextWindow } from "@/features/chat/usage";
import { selectAgyContext } from "@/features/chat/components/agy-context";
import type { LeaderBranch } from "./types";

export const LEADER_HIGH_CONTEXT_PERCENT = 50;

export interface LeaderUsageSample {
  usage: unknown;
  model?: string | null;
  fetchedAt: number;
}

export function leaderDeadlineInfo(branch: Pick<LeaderBranch, "deadlineAt" | "expired">, now = Date.now()) {
  const known = Number.isFinite(branch.deadlineAt) && branch.deadlineAt > 0;
  return { known, expired: branch.expired || (known && branch.deadlineAt <= now) };
}

/** Empty means the native per-engine default; explicit values override it. */
export function leaderRenewSeconds(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes * 60 : null;
}

export function leaderContextInfo(options: {
  branch: LeaderBranch;
  sample?: LeaderUsageSample | null;
  cachedUsage?: unknown;
  model?: string | null;
  claudeWindow?: number;
  claudeConfigKnown?: boolean;
  now?: number;
}) {
  const { branch, sample } = options;
  if (branch.engine === "agy") {
    const context = selectAgyContext(sample?.usage ?? options.cachedUsage);
    return {
      tokens: context.occupancyKnown ? context.total : undefined,
      max: context.max,
      percent: context.pct,
      source: sample ? "history" as const : undefined,
      fetchedAt: sample?.fetchedAt,
      suggestCompact: false,
    };
  }
  // Live result events and stamped assistant rows can contain the whole
  // turn's bill. Only the transcript's latest single-message usage is used.
  // cachedUsage supplies window metadata, never an occupancy numerator.
  const usage = sample?.usage;
  const parsed = parseUsage(usage);
  const windowUsage = mergeUsage(usage, options.cachedUsage);
  const resolvedCapacity = resolveContextMaxInfo({
    usage: windowUsage, engine: branch.engine,
    model: sample?.model || options.model || branch.model,
  });
  // Metadata-only Codex snapshots still report a real capacity even when
  // last_token_usage is unavailable. Preserve that denominator separately.
  const reportedWindow = reportedContextWindow(windowUsage);
  const capacity = reportedWindow ? { max: reportedWindow, known: true } : resolvedCapacity;
  const configKnown = branch.engine !== "claude" || options.claudeConfigKnown === true;
  const windowKnown = configKnown && (capacity.known || (branch.engine === "claude" && !!options.claudeWindow));
  const max = windowKnown ? contextDisplayMax(capacity.max, branch.engine === "claude" ? options.claudeWindow : undefined, capacity.known) : undefined;
  const tokens = parsed && [parsed.input, parsed.output, parsed.cacheRead, parsed.cacheWrite, parsed.total].every((n) => Number.isFinite(n) && n >= 0)
    && parsed.total > 0 ? parsed.total : undefined;
  const percent = tokens !== undefined && max !== undefined && Number.isFinite(max) && max > 0
    ? Math.max(0, Math.min(100, Math.round(tokens / max * 100))) : undefined;
  return {
    tokens, max, percent,
    source: sample ? "history" as const : undefined,
    fetchedAt: sample?.fetchedAt,
    suggestCompact: leaderDeadlineInfo(branch, options.now).expired && tokens !== undefined && max !== undefined
      && tokens / max * 100 >= LEADER_HIGH_CONTEXT_PERCENT,
  };
}
