import type { HostTaskCostApproval } from "@ccgui/plugin-sdk";
import type { CrossSessionCostReview } from "@/features/chat/cross-session-cost";
import { estimatePendingRequestCost } from "@/features/chat/pending-request-cost";
import { pendingRequestCostFacts, pendingRequestCostLines } from "@/features/chat/pending-request-cost-display";
import i18n from "@/lib/i18n";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Shared display facts for coordinator and child cost reviews. */
export function taskCostContextProjection(review: CrossSessionCostReview | undefined) {
  const now = Date.now(), cache = review?.cache;
  const boundary = !review?.cacheExpiryDisabled && cache && cache.reference?.cacheReadTokens !== 0
    ? [cache.startedAt + cache.ttlSeconds * 1000, cache.observedAt + (cache.reference?.maxTtlSeconds ?? cache.ttlSeconds) * 1000]
      .filter(at => Number.isFinite(at) && at > now).sort((a, b) => a - b)[0] : undefined;
  return {
    ...(boundary !== undefined ? { costEvidenceRefreshAt: boundary } : {}),
    ...(finite(review?.context.used) ? { used: review.context.used } : {}),
    ...(review?.context.capacityKnown && finite(review.context.max) ? { max: review.context.max } : {}),
    usageKind: review?.context.kind ?? "unknown" as const,
    ...(review ? { contextReference: review.context.reference, modelMismatch: review.context.modelMismatch,
      ...(review.context.usageModel ? { usageModel: review.context.usageModel } : {}),
      ...(review.cacheExpiryDisabled !== undefined ? { cacheExpiryDisabled: review.cacheExpiryDisabled } : {}) } : {}),
  };
}

export function taskCostCacheReference(review: CrossSessionCostReview | undefined): HostTaskCostApproval["cacheReference"] {
  const cache = review?.cache, ref = cache?.reference;
  if (!cache || !ref || ![ref.promptTokens, ref.cacheReadTokens, cache.startedAt, cache.observedAt, cache.ttlSeconds, ref.maxTtlSeconds].every(Number.isSafeInteger) ||
    ref.cacheReadTokens < 0 || ref.cacheReadTokens > ref.promptTokens || cache.startedAt <= 0 || cache.observedAt < cache.startedAt ||
    cache.observedAt > 8.64e15 || cache.ttlSeconds <= 0 || cache.ttlSeconds > ref.maxTtlSeconds) return undefined;
  return { promptTokens: ref.promptTokens, cacheReadTokens: ref.cacheReadTokens, observedAt: cache.observedAt,
    ttlSeconds: cache.ttlSeconds, maxTtlSeconds: ref.maxTtlSeconds };
}

/** Estimate the full held prompt, never its clipped plugin display excerpt. */
export function taskPendingCostEstimate(approval: Pick<HostTaskCostApproval, "target" | "model" | "used" | "usageKind" | "modelMismatch">, prompt: string, imageCount?: number) {
  const estimate = estimatePendingRequestCost({ engine: approval.target.engine, model: approval.model ?? "", prompt, imageCount,
    context: { used: approval.used, kind: approval.usageKind, modelMismatch: approval.modelMismatch } });
  return { ...estimate, displayLines: pendingRequestCostLines(estimate, i18n.t) };
}

/** Decision evidence excludes locale and snapshot read time. */
export function taskCostTelemetrySignature(approval: HostTaskCostApproval): string {
  return JSON.stringify([approval.cacheHeat, approval.used, approval.max, approval.usageKind, approval.contextReference,
    approval.modelMismatch, approval.usageModel, approval.cacheExpiryDisabled, approval.cacheReference,
    pendingRequestCostFacts(approval.requestEstimate)]);
}
