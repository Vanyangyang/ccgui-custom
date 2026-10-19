import type { AgyQuotaSnapshot } from "@/lib/ipc";
import { QUOTA_MAX_AGE, QUOTA_STALE_AGE } from "./subscription-quota";
export { compactQuotaReset, quotaResetCountdown } from "./subscription-quota";

export function agyQuotaModelGroup(model?: string): "gemini" | "third_party" | undefined {
  if (model?.startsWith("gemini-")) return "gemini";
  if (model?.startsWith("claude-") || model?.startsWith("gpt-oss-")) return "third_party";
  return undefined;
}

/** Reject ambiguous duplicates and validate every window independently. */
export function validAgyQuotaSnapshot(snapshot: AgyQuotaSnapshot, now = Date.now() / 1000): AgyQuotaSnapshot {
  const time = snapshot.collectedAt;
  const validTime = typeof time === "number" && Number.isFinite(time) && time > 0 && time <= now;
  if (!validTime || snapshot.status === "unavailable" || now - time >= QUOTA_MAX_AGE)
    return { ...snapshot, status: "unavailable", groups: [], errorCode: snapshot.errorCode ?? (validTime && now - time >= QUOTA_MAX_AGE ? "quota_expired" : "quota_not_available") };
  const input = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const groups: AgyQuotaSnapshot["groups"] = [];
  for (const id of ["gemini", "third_party"] as const) {
    const matches = input.filter(group => group?.id === id);
    if (matches.length !== 1) continue;
    const windows: AgyQuotaSnapshot["groups"][number]["windows"] = {};
    for (const name of ["fiveHour", "sevenDay"] as const) {
      const value = matches[0]?.windows?.[name];
      if (!value || typeof value.usedPercentage !== "number" || !Number.isFinite(value.usedPercentage) || value.usedPercentage < 0 || value.usedPercentage > 100) continue;
      if (value.resetsAt !== undefined && (typeof value.resetsAt !== "number" || !Number.isFinite(value.resetsAt) || value.resetsAt <= now || !Number.isFinite(new Date(value.resetsAt * 1000).getTime()))) continue;
      windows[name] = { usedPercentage: value.usedPercentage, ...(value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt }) };
    }
    if (Object.keys(windows).length) groups.push({ id, windows });
  }
  return { ...snapshot, groups, status: groups.length ? snapshot.status === "stale" || now - time >= QUOTA_STALE_AGE ? "stale" : "ready" : "unavailable" };
}

