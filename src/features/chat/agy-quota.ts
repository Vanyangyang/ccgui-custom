import type { AgyQuotaSnapshot } from "@/lib/ipc";
import { QUOTA_STALE_AGE } from "./subscription-quota";
export { compactQuotaReset, quotaResetCountdown } from "./subscription-quota";

export function agyQuotaModelGroup(model?: string, groups?: AgyQuotaSnapshot["groups"]): AgyQuotaSnapshot["groups"][number]["id"] | undefined {
  // Model variants share Gemini quota unless the API supplies a distinct bucket.
  if (model?.startsWith("gemini-4-argon") && groups?.some(group => group.id === "gemini_argon")) return "gemini_argon";
  if (model?.startsWith("gemini-")) return "gemini";
  if (model?.startsWith("claude-") || model?.startsWith("gpt-oss-")) return "third_party";
  return undefined;
}

/** Reject ambiguous duplicates and validate every window independently. */
export function validAgyQuotaSnapshot(snapshot: AgyQuotaSnapshot, now = Date.now() / 1000): AgyQuotaSnapshot {
  const time = snapshot.collectedAt;
  const validTime = typeof time === "number" && Number.isFinite(time) && time > 0 && time <= now;
  if (!validTime || snapshot.status === "unavailable")
    return { ...snapshot, status: "unavailable", groups: [], errorCode: snapshot.errorCode ?? "quota_not_available" };
  const input = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const groups: AgyQuotaSnapshot["groups"] = [];
  for (const id of ["gemini", "gemini_argon", "third_party"] as const) {
    const matches = input.filter(group => group?.id === id);
    if (matches.length !== 1) continue;
    const windows: AgyQuotaSnapshot["groups"][number]["windows"] = {};
    for (const name of ["fiveHour", "sevenDay"] as const) {
      const value = matches[0]?.windows?.[name];
      if (!value || typeof value.usedPercentage !== "number" || !Number.isFinite(value.usedPercentage) || value.usedPercentage < 0 || value.usedPercentage > 100) continue;
      if (value.resetsAt !== undefined && (typeof value.resetsAt !== "number" || !Number.isFinite(value.resetsAt) || !Number.isFinite(new Date(value.resetsAt * 1000).getTime()))) continue;
      windows[name] = { usedPercentage: value.usedPercentage, ...(value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt }) };
    }
    if (Object.keys(windows).length) groups.push({ id, windows });
  }
  const resetPassed = groups.some(group => Object.values(group.windows).some(window => window?.resetsAt !== undefined && window.resetsAt <= now));
  return { ...snapshot, groups, status: groups.length ? snapshot.status === "stale" || resetPassed || now - time >= QUOTA_STALE_AGE ? "stale" : "ready" : "unavailable" };
}

export function agyQuotaErrorKey(error?: string): string {
  const keys: Record<string, string> = {
    auth_missing: "AuthMissing", auth_invalid: "AuthInvalid", auth_read_failed: "AuthReadFailed",
    auth_expired: "AuthExpired", auth_changed: "AuthChanged",
    unsupported_auth_context: "UnsupportedContext", unsupported_auth_platform: "UnsupportedPlatform",
    quota_forbidden: "Forbidden", quota_rate_limited: "RateLimited", query_timeout: "Timeout",
    invalid_response: "InvalidResponse", query_failed: "QueryFailed", read_failed: "QueryFailed",
    refresh_cooldown: "Cooldown", quota_expired: "Expired",
  };
  return `chat.agyQuota${keys[error ?? ""] ?? "Unavailable"}`;
}

