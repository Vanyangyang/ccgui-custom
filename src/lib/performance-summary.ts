import type { collectPerformanceReport } from "./performance-report";
import type { NativePerformanceDiagnostics, NativeProcessSample } from "./performance-types";

export type PerformanceReport = Awaited<ReturnType<typeof collectPerformanceReport<NativePerformanceDiagnostics>>>;
export const SUMMARY_MAX_BYTES = 12_000;

function peak(values: (number | null | undefined)[]): number | null {
  const available = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return available.length ? Math.max(...available) : null;
}

function nearby<T>(samples: T[], score: (sample: T) => number | null | undefined): T[] {
  let best = -1;
  let highest = -Infinity;
  samples.forEach((sample, index) => {
    const value = score(sample);
    if (value != null && value > highest) { highest = value; best = index; }
  });
  return best < 0 ? [] : samples.slice(Math.max(0, best - 1), best + 2);
}

export function summarizePerformanceReport(report: PerformanceReport): string {
  const native = report.native.status === "available" ? report.native.data : undefined;
  const samples = native?.samples ?? [];
  const processes = new Map<string, Pick<NativeProcessSample, "pid" | "role" | "attribution"> & { peakCpuPercent: number | null; peakMemoryBytes: number | null }>();
  for (const sample of samples) {
    for (const process of sample.processes) {
      const key = `${process.pid}:${process.role}:${process.attribution}`;
      const previous = processes.get(key);
      processes.set(key, {
        pid: process.pid, role: process.role, attribution: process.attribution,
        peakCpuPercent: peak([previous?.peakCpuPercent, process.cpuPercent]),
        peakMemoryBytes: peak([previous?.peakMemoryBytes, process.memoryBytes]),
      });
    }
  }
  const renderer = report.renderer;
  const intervals = [...renderer.samples, renderer.pending];
  const durations = Object.fromEntries(["engineBatch", "liveRenderCommit", "eventLoopLag", "longTask"].map((key) => {
    const entries = intervals.map((sample) => sample.durations[key as keyof typeof sample.durations]).filter((entry) => entry !== undefined);
    return [key, { count: entries.reduce((sum, entry) => sum + entry.count, 0), maxMs: peak(entries.map((entry) => entry.maxMs)), totalMs: entries.reduce((sum, entry) => sum + entry.totalMs, 0) }];
  }));
  const summary = {
    schemaVersion: 1, kind: "performance-summary", generatedAt: report.generatedAt,
    version: report.version?.slice(0, 80) ?? null, buildMode: report.buildMode, retentionMs: 300000,
    native: {
      status: native?.status ?? "unavailable", enabled: native?.enabled ?? null,
      sampleCount: samples.length, from: samples[0]?.timestampMs ?? null, to: samples.at(-1)?.timestampMs ?? null,
      peakSystemCpuPercent: peak(samples.map((sample) => sample.systemCpuPercent)),
      peakMainCpuPercent: peak(samples.map((sample) => sample.mainCpuPercent)),
      peakMainMemoryBytes: peak(samples.map((sample) => sample.mainMemoryBytes)),
      peakSwapUsedBytes: peak(samples.map((sample) => sample.swapUsedBytes)),
      maxOmittedCandidates: peak(samples.map((sample) => sample.omittedCandidateProcessCount)),
      maxOmittedAppProcesses: peak(samples.map((sample) => sample.omittedAppProcessCount)),
      topProcesses: [...processes.values()].sort((left, right) => (right.peakCpuPercent ?? -1) - (left.peakCpuPercent ?? -1)).slice(0, 5),
      peakWindow: nearby(samples, (sample) => sample.systemCpuPercent).map((sample) => ({
        at: sample.timestampMs, systemCpuPercent: sample.systemCpuPercent, mainCpuPercent: sample.mainCpuPercent,
        mainMemoryBytes: sample.mainMemoryBytes, swapUsedBytes: sample.swapUsedBytes, status: sample.status,
      })),
    },
    renderer: {
      enabled: renderer.enabled, running: renderer.running, longTasksSupported: renderer.longTasksSupported,
      sampleCount: renderer.samples.length, from: renderer.samples[0]?.at ?? null, to: renderer.samples.at(-1)?.at ?? null,
      counters: Object.fromEntries(["engineEvents", "toolEvents", "textEvents"].map((key) => [key, intervals.reduce((sum, sample) => sum + (sample.counters[key as keyof typeof sample.counters] ?? 0), 0)])),
      durations,
      stallWindow: nearby(renderer.samples, (sample) => sample.durations.eventLoopLag?.maxMs).map((sample) => ({
        at: sample.at, hidden: sample.hidden, lagMs: sample.durations.eventLoopLag?.maxMs ?? null,
        batchMaxMs: sample.durations.engineBatch?.maxMs ?? null,
        context: sample.contextAvailable ? sample.context : null,
      })),
    },
    notes: [
      "Summary only; export the full JSON file for all samples. Missing metrics are null, not zero.",
      "Process CPU: one core=100%; system CPU: whole machine=100%. Neither measures GPU utilization.",
      "WebKit candidates may belong to other apps. PID reuse may merge process peaks; see full samples.",
      "Timer lag is not proof of a JS bottleneck. Live render commit is elapsed time, not pure parse CPU.",
      "Pending renderer counters are included. Tool events are not distinct tools or edited files.",
    ],
  };
  let text = JSON.stringify(summary, null, 2);
  if (new TextEncoder().encode(text).length > SUMMARY_MAX_BYTES) {
    summary.native.peakWindow = [];
    summary.renderer.stallWindow = [];
    text = JSON.stringify(summary);
  }
  return text;
}
