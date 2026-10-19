import type { ClaudeQuotaSnapshot, CodexQuotaSnapshot } from "@/lib/ipc";

export const QUOTA_STALE_AGE = 120;
export const QUOTA_MAX_AGE = 3600;

export function isNativeSubscriptionProvider(providerId?: string): boolean {
  return !providerId || providerId === "__local_settings_json__" || providerId === "__local_config_toml__";
}

/** Percentages are already in 0–100 units. Missing data never becomes zero. */
export function validSubscriptionQuotaSnapshot<T extends ClaudeQuotaSnapshot | CodexQuotaSnapshot>(
  snapshot: T,
  now = Date.now() / 1000,
  options?: { retainUntilNext?: boolean },
): T {
  const collectedAt = snapshot.collectedAt;
  const validTime = collectedAt !== undefined && Number.isFinite(collectedAt) && collectedAt > 0 && collectedAt <= now;
  // 【对话额度】Claude 不因会话开始、超过一小时或重置时间到达而清空。新快照到达后再替换。
  if (!options?.retainUntilNext && validTime && now - collectedAt >= QUOTA_MAX_AGE) {
    return { ...snapshot, status: "unavailable", windows: {}, errorCode: snapshot.errorCode ?? "quota_expired" };
  }
  if (snapshot.status === "unavailable" || !validTime) {
    return { ...snapshot, status: "unavailable", windows: {}, errorCode: snapshot.errorCode ?? "quota_not_available" };
  }
  const windows: ClaudeQuotaSnapshot["windows"] = {};
  for (const name of ["fiveHour", "sevenDay"] as const) {
    const window = snapshot.windows[name];
    if (!window || !Number.isFinite(window.usedPercentage) || window.usedPercentage < 0 || window.usedPercentage > 100) continue;
    if (window.resetsAt !== undefined && (!Number.isFinite(window.resetsAt) || !Number.isFinite(new Date(window.resetsAt * 1000).getTime()))) continue;
    if (!options?.retainUntilNext && window.resetsAt !== undefined && window.resetsAt <= now) continue;
    windows[name] = window;
  }
  if (!Object.keys(windows).length) return { ...snapshot, status: "unavailable", windows, errorCode: snapshot.errorCode ?? "quota_not_available" };
  return { ...snapshot, windows, status: snapshot.status === "stale" || now - collectedAt >= QUOTA_STALE_AGE ? "stale" : "ready" };
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
