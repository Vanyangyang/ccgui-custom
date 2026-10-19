import { describe, expect, it } from "vitest";
import type { AgyQuotaSnapshot } from "@/lib/ipc";
import { agyQuotaModelGroup, validAgyQuotaSnapshot } from "./agy-quota";
const NOW = 1_900_000_000;
const quota = (): AgyQuotaSnapshot => ({ status: "ready", collectedAt: NOW, source: "agy_usage", groups: [
  { id: "gemini", windows: { fiveHour: { usedPercentage: 0 }, sevenDay: { usedPercentage: 100 } } },
  { id: "third_party", windows: { fiveHour: { usedPercentage: 23.5, resetsAt: NOW + 1 } } },
] });
describe("AGY usage validation", () => {
  it("maps only recognized model slugs", () => {
    for (const model of ["gemini-3-pro", "gemini-flash"]) expect(agyQuotaModelGroup(model)).toBe("gemini");
    for (const model of ["claude-sonnet-4", "gpt-oss-120b"]) expect(agyQuotaModelGroup(model)).toBe("third_party");
    for (const model of [undefined, "custom", "Gemini Pro", "openai/gpt-oss-120b"]) expect(agyQuotaModelGroup(model)).toBeUndefined();
  });
  it("preserves actual endpoints and validates groups independently", () => {
    expect(validAgyQuotaSnapshot(quota(), NOW)).toEqual(quota());
    const data = quota();
    data.groups[0].windows.fiveHour!.usedPercentage = NaN;
    const valid = validAgyQuotaSnapshot(data, NOW);
    expect(valid.groups[0].windows.fiveHour).toBeUndefined();
    expect(valid.groups[0].windows.sevenDay?.usedPercentage).toBe(100);
    expect(valid.groups[1].windows.fiveHour?.usedPercentage).toBe(23.5);
  });
  it("rejects duplicate groups including a malformed duplicate without hiding other groups", () => {
    const data = quota();
    data.groups.push({ id: "gemini", windows: null } as unknown as AgyQuotaSnapshot["groups"][number]);
    expect(validAgyQuotaSnapshot(data, NOW).groups.map(group => group.id)).toEqual(["third_party"]);
  });
  it("rejects out-of-range, expired, nonnumeric and missing values", () => {
    for (const value of [-1, 101, Infinity, "10", null]) {
      const data = quota();
      data.groups = [{ id: "gemini", windows: { fiveHour: { usedPercentage: value as number } } }];
      expect(validAgyQuotaSnapshot(data, NOW).groups).toEqual([]);
    }
    expect(validAgyQuotaSnapshot(quota(), NOW + 1).groups).toHaveLength(1);
    const malformed = { ...quota(), groups: null } as unknown as AgyQuotaSnapshot;
    expect(validAgyQuotaSnapshot(malformed, NOW).status).toBe("unavailable");
  });
  it("marks stale at 120 seconds and expires at one hour; invalid timestamps never look fresh", () => {
    expect(validAgyQuotaSnapshot(quota(), NOW + 120).status).toBe("stale");
    expect(validAgyQuotaSnapshot(quota(), NOW + 3600)).toMatchObject({ status: "unavailable", groups: [], errorCode: "quota_expired" });
    for (const collectedAt of [undefined, NaN, Infinity, NOW + 1, 0]) expect(validAgyQuotaSnapshot({ ...quota(), collectedAt }, NOW).groups).toEqual([]);
    expect(validAgyQuotaSnapshot({ ...quota(), status: "unavailable" }, NOW).groups).toEqual([]);
    expect(validAgyQuotaSnapshot({ ...quota(), status: "stale", errorCode: "query_timeout" }, NOW)).toMatchObject({ status: "stale", errorCode: "query_timeout" });
  });
});

