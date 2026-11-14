import type { HostTaskCostApproval } from "@ccgui/plugin-sdk";
import type { TFunction } from "i18next";

/** The confirmation repeats the card's bounded planning evidence and explicitly
 * conditional API reference. This is display only and cannot resolve a request. */
export function costReviewDialogTelemetry(approval: HostTaskCostApproval, t: TFunction): string {
  const count = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const cache = t(approval.cacheExpiryDisabled ? "crossSession.costCacheExpiryDisabled" :
    approval.cacheHeat === "hot" ? "crossSession.costCacheHot" : approval.cacheHeat === "cold" ? "crossSession.costCacheCold" : "crossSession.costCacheUnknown");
  const lines = [...(approval.requestEstimate?.displayLines ?? []), t("crossSession.costDialogCacheSnapshot", { cache })];
  const used = approval.used, max = approval.max;
  if (!count(used)) lines.push(t("crossSession.costContextUnknown"));
  else if (approval.usageKind === "current_context" && !approval.modelMismatch && !approval.contextReference && count(max) && max > 0) {
    lines.push(t("crossSession.costContext", { used: used.toLocaleString(), max: max.toLocaleString(), pct: Math.round(used / max * 100) }));
  } else {
    lines.push(t(approval.usageKind === "last_request" || approval.modelMismatch ? "crossSession.costLastRequest" :
      approval.usageKind === "unknown" ? "crossSession.costDialogUsageUnknown" : "crossSession.costDialogUsage", { used: used.toLocaleString() }));
    if (count(max) && max > 0) lines.push(t("crossSession.costContextCapacity", { max: max.toLocaleString() }));
  }
  if (approval.contextReference) lines.push(t("crossSession.costReference"));
  if (approval.modelMismatch) {
    const model = typeof approval.usageModel === "string" ? Array.from(approval.usageModel.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 120).join("") : "";
    lines.push(t("crossSession.costModelChanged", { model: model || t("crossSession.costModelUnknown") }));
  }
  const ref = approval.cacheReference;
  if (ref && count(ref.promptTokens) && count(ref.cacheReadTokens) && ref.cacheReadTokens <= ref.promptTokens) {
    lines.push(t("crossSession.costDialogCacheReference", { prompt: ref.promptTokens.toLocaleString(), read: ref.cacheReadTokens.toLocaleString() }));
  }
  lines.push(t("crossSession.costHistoryWarning"));
  return lines.join("\n");
}
