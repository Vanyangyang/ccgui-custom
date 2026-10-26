import type { PromptCacheWindow } from "@/lib/ipc";
import type { TFunction } from "i18next";

export type CacheHeat = "hot" | "cold" | "unknown";

/** Codex has no finite retention estimate; Cursor uses a five-minute policy. */
export function supportsPromptCacheExpiry(engine: string | undefined): boolean {
  return engine !== "codex";
}

/** Client policy for Codex GPT routes, independent of missing/legacy TTL samples.
 * This disables time-based warnings; it does not assert a measured cache hit. */
export function usesUnlimitedPromptCache(engine: string | undefined, model: string | null | undefined): boolean {
  return engine === "codex" && /^gpt-.+/i.test(model?.trim() ?? "");
}

export function promptCacheForEngine(engine: string | undefined, cache: PromptCacheWindow | null | undefined) {
  return supportsPromptCacheExpiry(engine) ? cache : undefined;
}

function validWindow(cache: PromptCacheWindow | null | undefined): cache is PromptCacheWindow {
  return Boolean(cache && [cache.startedAt, cache.observedAt, cache.ttlSeconds, cache.reference?.maxTtlSeconds ?? cache.ttlSeconds].every(Number.isFinite) &&
    cache.startedAt > 0 && cache.observedAt >= cache.startedAt && cache.ttlSeconds > 0 &&
    (!cache.reference || (cache.reference.maxTtlSeconds >= cache.ttlSeconds &&
      Number.isFinite(cache.reference.cacheReadTokens) && Number.isFinite(cache.reference.promptTokens) &&
      cache.reference.cacheReadTokens >= 0 && cache.reference.promptTokens >= cache.reference.cacheReadTokens)));
}

/** Retention-window estimate, never proof of a cache hit or provider eviction. */
export function getSessionCacheHeat(cache: PromptCacheWindow | null | undefined, now = Date.now()): CacheHeat {
  if (!validWindow(cache) || !Number.isFinite(now) || now < cache.observedAt || cache.reference?.cacheReadTokens === 0) return "unknown";
  if (now < cache.startedAt + cache.ttlSeconds * 1000) return "hot";
  if (now >= cache.observedAt + (cache.reference?.maxTtlSeconds ?? cache.ttlSeconds) * 1000) return "cold";
  return "unknown";
}

/** Threshold ratio (last 10% of retention window) where an expiring-soon hourglass warning is shown. */
export const CACHE_EXPIRING_SOON_RATIO = 0.1;

/**
 * High-granularity continuous heat ratio in [0, 1] (1% steps / 0.01 precision):
 * Uses the recorded request start and policy/reference window only. Activity,
 * streaming and usage arrival cannot reset the clock. Unknown/missed caches
 * remain neutral; the gradient is not a cache-hit probability.
 */
export function getPromptCacheHeatRatio(
  cache: PromptCacheWindow | null | undefined,
  _updatedAt?: number | null,
  _streaming = false,
  now = Date.now(),
  engine?: string,
): number {
  // Codex's permanent red is a display policy, not evidence of a cache hit.
  if (engine === "codex") return 1;
  if (!validWindow(cache) || !Number.isFinite(now) || now < cache.observedAt || cache.reference?.cacheReadTokens === 0) return 0;
  const ttlMs = (cache.reference?.maxTtlSeconds ?? cache.ttlSeconds) * 1000;
  const remaining = (cache.startedAt + ttlMs - now) / ttlMs;
  return Math.round(Math.max(0, Math.min(1, remaining)) * 100) / 100;
}

/** True when a valid cache window is in its final 10% (0 < heatRatio <= 0.10). */
export function isPromptCacheExpiringSoon(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio > 0 && ratio <= CACHE_EXPIRING_SOON_RATIO;
}

export const cacheHeatTextKey = {
  hot: "chat.cacheWindowHot",
  cold: "chat.cacheWindowElapsed",
  unknown: "chat.cacheWindowUnknown",
} as const;

export interface CacheWindowSummary {
  /** Compact status badge text (e.g. "保留窗口内 · 60 分钟"). */
  statusLabel: string;
  /** Prominent remaining time or status headline (e.g. "预计剩余 45分28秒" / "已超出预计保留窗口"). */
  headline: string;
  /** Compact local expiry display (e.g. "2026/10/19 01:11:40 – 01:11:55"). */
  expiryRange?: string;
  /** Full local expiry range with date and seconds for complete reference. */
  fullExpiryRange?: string;
  /** Clarifies what the two timestamps represent (e.g. "请求耗时 15秒" or "15–20 分钟区间"). */
  expirySpanLabel?: string;
  /** Concise secondary note. */
  note: string;
  /** Optional mixed-TTL note. */
  mixedNote?: string;
  /** Whether the window is an advisory reference rather than a recorded policy TTL. */
  isReference: boolean;
  /** Whether the window is in the final 10% of its retention span (expiring soon). */
  expiringSoon: boolean;
}

export function cacheWindowSummary(
  t: TFunction,
  cache: PromptCacheWindow | null | undefined,
  heat: CacheHeat,
  now = Date.now(),
): CacheWindowSummary {
  if (!validWindow(cache)) {
    return {
      statusLabel: t("chat.cacheBadgeUnknown"),
      headline: t("chat.cacheHeadlineUnknown"),
      note: t("chat.cacheWindowUnknown"),
      isReference: false,
      expiringSoon: false,
    };
  }
  const isReference = Boolean(cache.reference);
  const maxTtlSeconds = cache.reference?.maxTtlSeconds ?? cache.ttlSeconds;
  const earliestMs = cache.startedAt + cache.ttlSeconds * 1000;
  const latestMs = cache.observedAt + maxTtlSeconds * 1000;
  const earliest = new Date(earliestMs);
  const latest = new Date(latestMs);
  const validDates = Number.isFinite(earliest.getTime()) && Number.isFinite(latest.getTime());

  const minutes =
    cache.ttlSeconds === maxTtlSeconds
      ? String(Math.round(cache.ttlSeconds / 60))
      : `${Math.round(cache.ttlSeconds / 60)}–${Math.round(maxTtlSeconds / 60)}`;

  const formatDuration = (ms: number) => {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0
      ? t("chat.cacheDurationMinSec", { minutes: m, seconds: String(s).padStart(2, "0") })
      : t("chat.cacheDurationSec", { seconds: s });
  };

  const safeNow = Number.isFinite(now) ? now : Date.now();
  const minRemainingMs = Math.max(0, earliestMs - safeNow);
  const maxRemainingMs = Math.max(0, latestMs - safeNow);
  const ratio = getPromptCacheHeatRatio(cache, undefined, false, safeNow);
  const expiringSoon = isPromptCacheExpiringSoon(ratio);

  let statusLabel: string;
  let headline: string;
  if (cache.reference?.cacheReadTokens === 0) {
    statusLabel = t("chat.cacheBadgeMiss", { minutes });
    headline = t("chat.cacheReferenceMiss");
  } else if (heat === "hot") {
    statusLabel = t(
      expiringSoon
        ? isReference
          ? "chat.cacheBadgeReferenceExpiringSoon"
          : "chat.cacheBadgeExpiringSoon"
        : isReference
          ? "chat.cacheBadgeReferenceHot"
          : "chat.cacheBadgeHot",
      { minutes },
    );
    if (cache.ttlSeconds !== maxTtlSeconds) {
      headline = t("chat.cacheHeadlineRemainingRange", {
        min: formatDuration(minRemainingMs),
        max: formatDuration(maxRemainingMs),
      });
    } else {
      headline = t("chat.cacheHeadlineRemaining", { duration: formatDuration(maxRemainingMs) });
    }
  } else if (heat === "cold") {
    statusLabel = t(isReference ? "chat.cacheBadgeReferenceCold" : "chat.cacheBadgeCold", { minutes });
    headline = t(isReference ? "chat.cacheHeadlineReferenceCold" : "chat.cacheHeadlineCold");
  } else {
    statusLabel = t(isReference ? "chat.cacheBadgeReferenceUncertain" : "chat.cacheBadgeUncertain", { minutes });
    headline = maxRemainingMs > 0
      ? t("chat.cacheHeadlineUncertainRemaining", { duration: formatDuration(maxRemainingMs) })
      : t("chat.cacheHeadlineUncertain");
  }

  let expiryRange: string | undefined;
  let fullExpiryRange: string | undefined;
  let expirySpanLabel: string | undefined;
  if (validDates) {
    const fullFormat = (time: Date) =>
      t("chat.cacheWindowTimestamp", {
        time,
        formatParams: {
          time: {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          },
        },
      });
    const timeOnlyFormat = (time: Date) =>
      t("chat.cacheWindowTimestamp", {
        time,
        formatParams: {
          time: {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          },
        },
      });
    fullExpiryRange =
      earliest.getTime() === latest.getTime()
        ? fullFormat(earliest)
        : `${fullFormat(earliest)} – ${fullFormat(latest)}`;

    const sameDay =
      earliest.getFullYear() === latest.getFullYear() &&
      earliest.getMonth() === latest.getMonth() &&
      earliest.getDate() === latest.getDate();
    expiryRange =
      earliest.getTime() === latest.getTime()
        ? fullFormat(earliest)
        : sameDay
          ? `${fullFormat(earliest)} – ${timeOnlyFormat(latest)}`
          : fullExpiryRange;

    if (earliest.getTime() !== latest.getTime()) {
      if (cache.ttlSeconds !== maxTtlSeconds) {
        expirySpanLabel = t("chat.cacheCardSpanTtlRange", { minutes });
      } else {
        expirySpanLabel = t("chat.cacheCardSpanRequestTurn", {
          duration: formatDuration(cache.observedAt - cache.startedAt),
        });
      }
    }
  }

  let note: string;
  if (cache.reference) {
    const reference = cache.reference;
    const provider = t(
      cache.source === "agy-vertex-reference"
        ? "chat.cacheReferenceVertex"
        : cache.source === "agy-anthropic-reference"
          ? "chat.cacheReferenceClaude"
          : "chat.cacheReferenceGemini",
    );
    const observation =
      reference.cacheReadTokens > 0
        ? t("chat.cacheReferenceHit", {
            percent: Math.round((reference.cacheReadTokens / reference.promptTokens) * 100),
          })
        : t("chat.cacheReferenceMiss");
    const status = t(
      heat === "hot"
        ? "chat.cacheReferenceWithin"
        : heat === "cold"
          ? "chat.cacheReferenceElapsed"
          : "chat.cacheReferenceUncertain",
    );
    note = t("chat.cacheReferenceWindow", { provider, minutes, observation, status });
  } else {
    note = t(cacheHeatTextKey[heat], { minutes: cache.ttlSeconds / 60 });
  }

  return {
    statusLabel,
    headline,
    expiryRange,
    fullExpiryRange,
    expirySpanLabel,
    note,
    mixedNote: cache.source === "anthropic-mixed" ? t("chat.cacheWindowMixed") : undefined,
    isReference,
    expiringSoon,
  };
}

export function cacheWindowText(t: TFunction, cache: PromptCacheWindow | null | undefined, heat: CacheHeat): string {
  const expiry = cacheWindowExpiryText(t, cache);
  let text: string;
  if (cache?.reference && validWindow(cache)) {
    const reference = cache.reference;
    const provider = t(cache.source === "agy-vertex-reference" ? "chat.cacheReferenceVertex" : cache.source === "agy-anthropic-reference" ? "chat.cacheReferenceClaude" : "chat.cacheReferenceGemini");
    const minutes = cache.ttlSeconds === reference.maxTtlSeconds ? String(cache.ttlSeconds / 60) : `${cache.ttlSeconds / 60}–${reference.maxTtlSeconds / 60}`;
    const observation = reference.cacheReadTokens > 0
      ? t("chat.cacheReferenceHit", { percent: Math.round(reference.cacheReadTokens / reference.promptTokens * 100) })
      : t("chat.cacheReferenceMiss");
    const status = t(heat === "hot" ? "chat.cacheReferenceWithin" : heat === "cold" ? "chat.cacheReferenceElapsed" : "chat.cacheReferenceUncertain");
    text = t("chat.cacheReferenceWindow", { provider, minutes, observation, status });
  } else {
    text = t(cacheHeatTextKey[heat], { minutes: (cache?.ttlSeconds ?? 0) / 60 });
    if (cache?.source === "anthropic-mixed") text += ` ${t("chat.cacheWindowMixed")}`;
  }
  return expiry ? `${expiry}\n${text}` : text;
}

/** Request timing is bounded; these are window endpoints, not provider eviction times. */
function cacheWindowExpiryText(t: TFunction, cache: PromptCacheWindow | null | undefined): string {
  if (!validWindow(cache)) return "";
  const earliest = new Date(cache.startedAt + cache.ttlSeconds * 1000);
  const latest = new Date(cache.observedAt + (cache.reference?.maxTtlSeconds ?? cache.ttlSeconds) * 1000);
  if (!Number.isFinite(earliest.getTime()) || !Number.isFinite(latest.getTime())) return "";
  const format = (time: Date) => t("chat.cacheWindowTimestamp", {
    time,
    formatParams: { time: {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    } },
  });
  const time = earliest.getTime() === latest.getTime()
    ? format(earliest)
    : `${format(earliest)} – ${format(latest)}`;
  return t(cache.reference ? "chat.cacheReferenceExpiry" : "chat.cacheWindowExpiry", { time });
}

export function nextCacheBoundary(cache: PromptCacheWindow | null | undefined, now: number): number | undefined {
  if (!validWindow(cache) || cache.reference?.cacheReadTokens === 0) return undefined;
  return [
    cache.observedAt,
    cache.startedAt + cache.ttlSeconds * 1000,
    cache.observedAt + (cache.reference?.maxTtlSeconds ?? cache.ttlSeconds) * 1000,
  ]
    .filter((time) => time > now).sort((a, b) => a - b)[0];
}
