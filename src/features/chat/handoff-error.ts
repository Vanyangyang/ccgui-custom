import i18n from "@/lib/i18n";

const TIMEOUT_DETAIL = "\n\n[handoff-timeout]\n";
const BUDGET_DETAIL = "\n\n[handoff-budget]\n";
const AUTH_DETAIL = "\n\n[handoff-auth]\n";
const SOURCE_DETAIL = "\n\n[handoff-source]\n";

/** Explain native failures without inferring completion, cancellation or retrying. */
export function formatHandoffError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes(TIMEOUT_DETAIL) || raw.includes(BUDGET_DETAIL) || raw.includes(AUTH_DETAIL) || raw.includes(SOURCE_DETAIL)) return raw;
  if (raw.includes("full handoff visible history changed during compression")) {
    return `${i18n.t("chat.handoffVisibleHistoryChanged")}${SOURCE_DETAIL}${raw}`;
  }
  if (["full handoff source changed", "full handoff source kept changing", "full handoff source identity changed"].some(code => raw.includes(code))) {
    return `${i18n.t("chat.handoffSourceCheckFailed")}${SOURCE_DETAIL}${raw}`;
  }
  const authStage = /(?:\[|;\s*)stage=(oauth_token_mismatch|oauth_account_changed)(?=;|\])/.exec(raw)?.[1];
  if (authStage) {
    const key = authStage === "oauth_token_mismatch" ? "chat.handoffAuthTokenChanged" : "chat.handoffAuthAccountChanged";
    return `${i18n.t(key)}${AUTH_DETAIL}${raw}`;
  }
  const budgetKey = ["full handoff visible history exceeds", "full handoff visible text exceeds"].some(code => raw.includes(code))
    ? "chat.handoffHistorySize"
    : raw.includes("full handoff summary budget unavailable") || raw.includes("full handoff exact anchors exceed")
    ? "chat.handoffSummaryCapacity"
    : raw.includes("full handoff intermediate summary exceeds 4000 UTF-16 units")
      ? "chat.handoffIntermediateLength"
      : ["full handoff model call budget exceeded", "full handoff intermediate summaries exceed", "full handoff merge depth exceeded", "full handoff reduction did not converge", "full handoff summary and exact anchors exceed"].some(code => raw.includes(code))
        ? "chat.handoffLengthBudget" : null;
  if (budgetKey) return `${i18n.t(budgetKey)}${BUDGET_DETAIL}${raw}`;
  if (!raw.includes("handoff summary timed out")) return raw;

  // Only trust an explicit native measurement, never the configured timeout or
  // a segment number. Ambiguous/invalid measurements omit the elapsed claim.
  const measurements = [...raw.matchAll(/(?:\[|;\s*)elapsed_ms=([^;\]\s]+)(?=;|\])/g)];
  const elapsed = measurements.length === 1 && /^\d+$/.test(measurements[0][1])
    ? Number(measurements[0][1]) : NaN;
  const wait = Number.isSafeInteger(elapsed) && elapsed > 0
    ? i18n.t("chat.handoffTimeoutWait", { seconds: Math.round(elapsed / 100) / 10 }) : "";
  return `${i18n.t("chat.handoffTimeout", { wait })}${TIMEOUT_DETAIL}${raw}`;
}
