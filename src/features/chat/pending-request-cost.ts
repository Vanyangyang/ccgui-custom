import type { HostTaskRequestCostEstimate } from "@ccgui/plugin-sdk";

interface PendingRequestCostInput {
  engine: string;
  model: string;
  prompt: string;
  imageCount?: number;
  context: {
    used?: number;
    kind: "current_context" | "last_request" | "unknown";
    modelMismatch?: boolean;
  };
  now?: number;
}

const CATALOG_START = Date.parse("2026-10-28T00:00:00Z");
const PRICE_TRANSITION = Date.parse("2026-12-01T00:00:00Z");
const CATALOG_EXPIRY = Date.parse("2027-01-01T00:00:00Z");

/** Local UTF-8 heuristic, not tokenization or a provider billing quote. */
export function estimatePendingRequestCost({
  engine, model, prompt, imageCount, context, now = Date.now(),
}: PendingRequestCostInput): HostTaskRequestCostEstimate {
  const textUtf8Bytes = new TextEncoder().encode(prompt).length;
  const textTokens = { lower: Math.ceil(textUtf8Bytes / 4), upper: textUtf8Bytes };
  const contextBasis = context.modelMismatch ? "model_mismatch" : context.kind;
  const contextTokens = contextBasis !== "unknown" && contextBasis !== "model_mismatch"
    && typeof context.used === "number" && Number.isSafeInteger(context.used) && context.used >= 0
    ? context.used : undefined;
  const estimate: HostTaskRequestCostEstimate = {
    method: "utf8-quarter-to-byte-v1",
    textCharacters: Array.from(prompt).length,
    textUtf8Bytes,
    textTokens,
    imageCount,
    contextBasis,
    contextTokens,
    inputTokens: contextTokens === undefined ? undefined : {
      lower: contextTokens + textTokens.lower,
      upper: contextTokens + textTokens.upper,
    },
  };

  // Exact catalog membership only: no family aliases or cross-engine pricing.
  if (engine !== "agy" || model !== "gemini-4-argon") {
    estimate.unavailableReason = "model_price_unverified";
    return estimate;
  }
  if (!Number.isFinite(now) || now < CATALOG_START || now >= CATALOG_EXPIRY) {
    estimate.unavailableReason = "price_outdated";
    return estimate;
  }

  const laterPeriod = now >= PRICE_TRANSITION;
  const pricing: NonNullable<HostTaskRequestCostEstimate["pricing"]> = {
    model,
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing#gemini-4-argon",
    checkedAt: "2026-10-28",
    effectiveFrom: laterPeriod ? PRICE_TRANSITION : CATALOG_START,
    effectiveUntil: laterPeriod ? CATALOG_EXPIRY : PRICE_TRANSITION,
    inputUsdPerMillion: laterPeriod ? 4 : 2,
    cacheReadUsdPerMillion: laterPeriod ? 0.2 : 0.1,
    outputUsdPerMillion: laterPeriod ? 20 : 10,
    basis: "api_standard_reference",
  };
  estimate.pricing = pricing;
  if (contextTokens !== undefined) {
    // Unknown cache reuse spans all cached to all fresh; new text is always fresh.
    estimate.inputUsd = {
      lower: (contextTokens * pricing.cacheReadUsdPerMillion
        + textTokens.lower * pricing.inputUsdPerMillion) / 1_000_000,
      upper: (contextTokens + textTokens.upper) * pricing.inputUsdPerMillion / 1_000_000,
    };
  }
  return estimate;
}
