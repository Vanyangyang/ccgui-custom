import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPerformanceReport } from "./performance-export";
import type { PerformanceReport } from "./performance-summary";

const mocks = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn(), web: false }));
vi.mock("./platform", () => ({ get isWeb() { return mocks.web; }, pickSavePath: mocks.save }));
vi.mock("./ipc", () => ({ ipc: { writeFile: mocks.write } }));
beforeEach(() => { mocks.save.mockReset(); mocks.write.mockReset(); mocks.web = false; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const report = { generatedAt: "2026-09-23T00:00:00.000Z", native: { samples: [1, 2, 3] } } as unknown as PerformanceReport;

describe("full diagnostic file export", () => {
  it("writes full compact JSON only to the selected path", async () => {
    mocks.save.mockResolvedValue("/chosen/report.json");
    await expect(exportPerformanceReport(report, "Export")).resolves.toBe("saved");
    expect(mocks.write).toHaveBeenCalledWith("/chosen/report.json", JSON.stringify(report));
  });
  it("does not write or claim success on cancellation", async () => {
    mocks.save.mockResolvedValue(null);
    await expect(exportPerformanceReport(report, "Export")).resolves.toBe("cancelled");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("propagates write failure", async () => {
    mocks.save.mockResolvedValue("/chosen/report.json");
    mocks.write.mockRejectedValue(new Error("disk unavailable"));
    await expect(exportPerformanceReport(report, "Export")).rejects.toThrow("disk unavailable");
  });

  it("downloads locally in web mode and releases the blob URL", async () => {
    mocks.web = true;
    vi.useFakeTimers();
    const revoke = vi.fn();
    const create = vi.fn(() => "blob:diagnostic-fixture");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await expect(exportPerformanceReport(report, "Export")).resolves.toBe("downloaded");
    expect(create.mock.calls).toHaveLength(1);
    expect(click).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:diagnostic-fixture");
    expect(vi.getTimerCount()).toBe(0);
  });
});
