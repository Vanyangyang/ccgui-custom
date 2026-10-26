import type { ClaudeQuotaSnapshot, CodexQuotaSnapshot } from "@/lib/ipc";

export const QUOTA_STALE_AGE = 120;
// Balances/reset credits keep their existing expiry; usage percentages do not.
export const QUOTA_CREDITS_MAX_AGE = 3600;

export function isNativeSubscriptionProvider(providerId?: string): boolean {
  return !providerId || providerId === "__local_settings_json__" || providerId === "__local_config_toml__";
}

/** Percentages are already in 0–100 units. Missing data never becomes zero. */
export function validSubscriptionQuotaSnapshot<T extends ClaudeQuotaSnapshot | CodexQuotaSnapshot>(
  snapshot: T,
  now = Date.now() / 1000,
): T {
  const collectedAt = snapshot.collectedAt;
  const validTime = collectedAt !== undefined && Number.isFinite(collectedAt) && collectedAt > 0 && collectedAt <= now;
  // Age and reset boundaries make a sample stale, not absent. Only a new
  // authoritative snapshot or identity invalidation replaces its values.
  if (snapshot.status === "unavailable" || !validTime) {
    return { ...snapshot, status: "unavailable", windows: {}, errorCode: snapshot.errorCode ?? "quota_not_available" };
  }
  const windows: ClaudeQuotaSnapshot["windows"] = {};
  for (const name of ["fiveHour", "sevenDay"] as const) {
    const window = snapshot.windows[name];
    if (!window || !Number.isFinite(window.usedPercentage) || window.usedPercentage < 0 || window.usedPercentage > 100) continue;
    if (window.resetsAt !== undefined && (!Number.isFinite(window.resetsAt) || !Number.isFinite(new Date(window.resetsAt * 1000).getTime()))) continue;
    windows[name] = window;
  }
  if (!Object.keys(windows).length) return { ...snapshot, status: "unavailable", windows, errorCode: snapshot.errorCode ?? "quota_not_available" };
  const resetPassed = Object.values(windows).some(window => window?.resetsAt !== undefined && window.resetsAt <= now);
  return { ...snapshot, windows, status: snapshot.status === "stale" || resetPassed || now - collectedAt >= QUOTA_STALE_AGE ? "stale" : "ready" };
}

/** An IPC outage is not evidence of logout. Keep the last sample on this route;
 * a successful native read still owns account/provider invalidation. */
export function quotaReadFailed<T extends { status: string; errorCode?: string }>(previous: T, empty: T): T {
  return previous.status === "ready" || previous.status === "stale"
    ? { ...previous, status: "stale", errorCode: "read_failed" }
    : { ...empty, errorCode: "read_failed" };
}

export function quotaResetCountdown(resetsAt: number, now = Date.now() / 1000): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.ceil((resetsAt - now) / 60));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** Compact local reset label. Weekly and cross-day windows need a date. */
export function compactQuotaReset(resetsAt: number | undefined, window: "fiveHour" | "sevenDay", locale: string, now = Date.now() / 1000): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(now) || resetsAt <= now) return undefined;
  const reset = new Date(resetsAt * 1000);
  const current = new Date(now * 1000);
  if (!Number.isFinite(reset.getTime()) || !Number.isFinite(current.getTime())) return undefined;
  const otherYear = reset.getFullYear() !== current.getFullYear();
  const otherDay = otherYear || reset.getMonth() !== current.getMonth() || reset.getDate() !== current.getDate();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset);
  if (window === "fiveHour" && !otherDay) return time;
  const date = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", ...(otherYear ? { year: "numeric" as const } : {}) }).format(reset);
  return `${date} ${time}`;
}
