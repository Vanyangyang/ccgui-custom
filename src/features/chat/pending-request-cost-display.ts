import type { HostTaskRequestCostEstimate } from "@ccgui/plugin-sdk";
import type { TFunction } from "i18next";

/** A shared explanation for the host card, native confirmation and workbench.
 * The lower/upper values compare cache scenarios; they are not billing limits. */
export function pendingRequestCostLines(value: HostTaskRequestCostEstimate, t: TFunction): string[] {
  const count = (n: number) => n.toLocaleString();
  const usd = (n: number) => n > 0 && n < 0.0001 ? "<$0.0001" : `$${n.toFixed(4)}`;
  const lines = [t("crossSession.pendingTextEstimate", { characters: count(value.textCharacters),
    lower: count(value.textTokens.lower), upper: count(value.textTokens.upper),
    images: value.imageCount === undefined ? t("crossSession.pendingImagesUnknown") : t("crossSession.pendingImages", { count: value.imageCount }) })];
  if (value.inputTokens) lines.push(t(value.contextBasis === "last_request" ? "crossSession.pendingInputHistory" : "crossSession.pendingInputCurrent",
    { lower: count(value.inputTokens.lower), upper: count(value.inputTokens.upper) }));
  else lines.push(t(value.contextBasis === "model_mismatch" ? "crossSession.pendingContextMismatch" : "crossSession.pendingContextMissing"));
  if (value.pricing) {
    if (value.inputUsd) lines.push(t("crossSession.pendingInputPrice", { lower: usd(value.inputUsd.lower), upper: usd(value.inputUsd.upper) }));
    else lines.push(t("crossSession.pendingPriceNoContext"));
    const price = value.pricing;
    lines.push(t("crossSession.pendingPriceRates", { input: price.inputUsdPerMillion, cache: price.cacheReadUsdPerMillion, output: price.outputUsdPerMillion }));
    lines.push(t("crossSession.pendingPriceSource", { date: price.checkedAt, url: price.sourceUrl }));
  } else lines.push(t(value.unavailableReason === "price_outdated" ? "crossSession.pendingPriceOutdated" : "crossSession.pendingPriceMissing"));
  lines.push(t("crossSession.pendingEstimateLimits"));
  lines.push(t("crossSession.pendingEstimateOptions"));
  return lines;
}

/** Locale/presentation changes do not change the evidence a human reviewed. */
export function pendingRequestCostFacts(value: HostTaskRequestCostEstimate | undefined) {
  if (!value) return undefined;
  const { displayLines: _display, ...facts } = value;
  return facts;
}
