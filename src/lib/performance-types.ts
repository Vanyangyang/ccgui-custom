export interface NativeProcessSample {
  pid: number;
  role: "main" | "child" | "webkit-gpu-candidate" | "webkit-content-candidate" | "other";
  attribution: "main" | "appDescendant" | "unattributedCandidate";
  memoryBytes: number | null;
  cpuPercent: number | null;
  cpuStatus: "baseline" | "available" | "unavailable";
}

export interface NativePerformanceSample {
  timestampMs: number;
  sampleDurationMs: number;
  logicalCpuCount: number | null;
  systemCpuPercent: number | null;
  systemMemoryTotalBytes: number | null;
  systemMemoryAvailableBytes: number | null;
  swapUsedBytes: number | null;
  status: "available" | "unavailable";
  error: string | null;
  mainMemoryBytes: number | null;
  mainCpuPercent: number | null;
  processes: NativeProcessSample[];
  omittedAppProcessCount: number;
  omittedCandidateProcessCount: number;
}

export interface NativePerformanceDiagnostics {
  enabled: boolean;
  schemaVersion: number;
  os: string;
  arch: string;
  logicalCpuCount: number | null;
  sessionStartedAtMs: number;
  generatedAtMs: number;
  samplingIntervalMs: number;
  retentionMs: number;
  sampleCapacity: number;
  processLimit: number;
  persistence: "currentSessionOnly";
  status: "starting" | "running" | "unavailable" | "stale" | "stopped" | "disabled";
  limitations: string[];
  samples: NativePerformanceSample[];
}
