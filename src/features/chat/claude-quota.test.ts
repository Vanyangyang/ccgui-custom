import { describe, expect, it } from "vitest";
import { validClaudeQuotaSnapshot, compactQuotaReset, quotaResetCountdown, isClaudeNativeProvider } from "./claude-quota";
import type { ClaudeQuotaSnapshot } from "@/lib/ipc";

const now = 1_900_000_000;
const snapshot = (windows: ClaudeQuotaSnapshot["windows"], collectedAt = now): ClaudeQuotaSnapshot => ({ status: "ready", windows, collectedAt });

describe("Claude account quota display", () => {
  it("uses percent units and retains a real zero separately from missing data", () => {
    expect(validClaudeQuotaSnapshot(snapshot({ fiveHour: { usedPercentage: 0 }, sevenDay: { usedPercentage: 80, resetsAt: now + 100 } }), now).windows)
      .toEqual({ fiveHour: { usedPercentage: 0 }, sevenDay: { usedPercentage: 80, resetsAt: now + 100 } });
    expect(validClaudeQuotaSnapshot(snapshot({ fiveHour: { usedPercentage: 0 } }), now).windows.sevenDay).toBeUndefined();
  });
  it("drops expired or malformed windows without inventing percentages", () => {
    for (const usedPercentage of [NaN, Infinity, -1, 100.1]) {
      expect(validClaudeQuotaSnapshot(snapshot({ fiveHour: { usedPercentage } }), now).windows).toEqual({});
    }
    for (const resetsAt of [now, now - 1, NaN, Infinity, 1e20]) {
      expect(validClaudeQuotaSnapshot(snapshot({ fiveHour: { usedPercentage: 80, resetsAt }, sevenDay: { usedPercentage: 30 } }), now).windows)
        .toEqual({ sevenDay: { usedPercentage: 30 } });
    }
  });
  it("keeps fractional percentage units and validates cache age", () => {
    const data = snapshot({ fiveHour: { usedPercentage: 0.8 } });
    expect(validClaudeQuotaSnapshot(data, now).windows.fiveHour?.usedPercentage).toBe(0.8);
    expect(validClaudeQuotaSnapshot(data, now + 119).status).toBe("ready");
    expect(validClaudeQuotaSnapshot(data, now + 120).status).toBe("stale");
    expect(validClaudeQuotaSnapshot(data, now + 601)).toMatchObject({ status: "stale", windows: { fiveHour: { usedPercentage: 0.8 } } });
    expect(validClaudeQuotaSnapshot(data, now + 3599).windows.fiveHour?.usedPercentage).toBe(0.8);
    expect(validClaudeQuotaSnapshot(data, now + 3600)).toMatchObject({ status: "unavailable", windows: {}, errorCode: "quota_expired" });
    expect(validClaudeQuotaSnapshot({ ...data, status: "unavailable" }, now).windows).toEqual({});
    for (const collectedAt of [undefined, NaN, Infinity, 0, now + 1]) {
      expect(validClaudeQuotaSnapshot({ ...data, collectedAt }, now).windows).toEqual({});
    }
  });
  it("rounds reset countdown up to the next minute", () => {
    expect(quotaResetCountdown(now + 3601, now)).toEqual({ hours: 1, minutes: 1 });
  });
  it("formats local reset times with dates for weekly, cross-day and cross-year windows", () => {
    const local = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month - 1, day, hour, minute).getTime() / 1000;
    const current = local(2026, 10, 2, 21, 0);
    expect(compactQuotaReset(local(2026, 10, 2, 23, 49), "fiveHour", "zh-CN", current)).toBe("23:49");
    expect(compactQuotaReset(local(2026, 10, 3, 0, 10), "fiveHour", "zh-CN", current)).toBe("10/3 00:10");
    expect(compactQuotaReset(local(2026, 10, 5, 3, 59), "sevenDay", "zh-CN", current)).toBe("10/5 03:59");
    expect(compactQuotaReset(local(2026, 10, 5, 3, 59), "sevenDay", "en-US", current)).toBe("10/5 03:59");
    expect(compactQuotaReset(local(2026, 10, 2, 23, 49), "sevenDay", "zh-CN", current)).toBe("10/2 23:49");
    expect(compactQuotaReset(local(2027, 1, 1, 0, 10), "fiveHour", "zh-CN", local(2026, 12, 31, 22, 0))).toBe("2027/1/1 00:10");
  });
  it("does not display missing, malformed or expired reset times", () => {
    for (const reset of [undefined, NaN, Infinity, 1e20, now, now - 1]) {
      expect(compactQuotaReset(reset, "fiveHour", "zh-CN", now)).toBeUndefined();
    }
    expect(compactQuotaReset(now + 100, "sevenDay", "en", NaN)).toBeUndefined();
  });
  it("reports unavailable when every window is absent or expired and keeps explicit guard errors", () => {
    for (const windows of [{}, { fiveHour: { usedPercentage: 35, resetsAt: now } }]) {
      expect(validClaudeQuotaSnapshot(snapshot(windows), now)).toMatchObject({ status: "unavailable", windows: {}, errorCode: "quota_not_available" });
    }
    expect(validClaudeQuotaSnapshot({ ...snapshot({}), errorCode: "provider_auth_unavailable" }, now).errorCode).toBe("provider_auth_unavailable");
  });
  it("recognizes native aliases while excluding custom API channels", () => {
    expect(isClaudeNativeProvider()).toBe(true);
    expect(isClaudeNativeProvider("__local_settings_json__")).toBe(true);
    expect(isClaudeNativeProvider("__local_config_toml__")).toBe(true);
    expect(isClaudeNativeProvider("custom-provider")).toBe(false);
  });
});
