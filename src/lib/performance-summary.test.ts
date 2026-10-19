import { describe, expect, it } from "vitest";
import { collectPerformanceReport } from "./performance-report";
import { summarizePerformanceReport, SUMMARY_MAX_BYTES } from "./performance-summary";
import type { NativePerformanceDiagnostics } from "./performance-types";

describe("bounded diagnostic summary", () => {
  it("keeps missing metrics unavailable rather than zero", async () => {
    const report = await collectPerformanceReport<NativePerformanceDiagnostics>(() => Promise.reject(), async () => null);
    const summary = JSON.parse(summarizePerformanceReport(report));
    expect(summary.native.status).toBe("unavailable");
    expect(summary.native.peakSystemCpuPercent).toBeNull();
    expect(summary.renderer.sampleCount).toBe(0);
  });

  it("bounds output while retaining peaks, attribution and nearby samples", async () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({
      timestampMs: 1000 + index * 5000, systemCpuPercent: index === 30 ? 99 : 10,
      mainCpuPercent: 20, mainMemoryBytes: 1000, swapUsedBytes: null,
      sampleDurationMs: 4, status: "available", omittedCandidateProcessCount: 2,
      omittedAppProcessCount: 0,
      processes: Array.from({ length: 32 }, (_, pid) => ({ pid, role: "webkit-gpu-candidate",
        attribution: "unattributedCandidate", cpuPercent: pid + index, memoryBytes: 2000, cpuStatus: "available" })),
    }));
    const report = await collectPerformanceReport(async () => ({ enabled: true, status: "running", samples }) as unknown as NativePerformanceDiagnostics, async () => "1.0.8");
    const text = summarizePerformanceReport(report);
    const summary = JSON.parse(text);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(summary.native.peakSystemCpuPercent).toBe(99);
    expect(summary.native.topProcesses).toHaveLength(5);
    expect(summary.native.topProcesses[0].attribution).toBe("unattributedCandidate");
    expect(summary.native.peakWindow.map((sample: { at: number }) => sample.at)).toEqual([146000, 151000, 156000]);
    expect(summary.native.maxOmittedCandidates).toBe(2);
    expect(JSON.stringify(report.native)).toContain('"processes"');
  });
});
