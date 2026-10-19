import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { performanceRecorder } from "@/lib/performance-diagnostics";
import { initializePerformancePreference } from "@/lib/performance-preference";
import { PerformanceDiagnosticsDialog } from "@/features/settings/PerformanceDiagnostics";

ipc.performanceDiagnostics = async () => ({
  enabled: true,
  schemaVersion: 1,
  os: "fixture",
  arch: "fixture",
  logicalCpuCount: 12,
  sessionStartedAtMs: Date.now(),
  generatedAtMs: Date.now(),
  samplingIntervalMs: 5000,
  retentionMs: 300000,
  sampleCapacity: 60,
  processLimit: 32,
  persistence: "currentSessionOnly",
  status: "running",
  limitations: ["Synthetic native sample; not a real app CPU measurement."],
  samples: [{ timestampMs: Date.now(), sampleDurationMs: 1, logicalCpuCount: 12, systemCpuPercent: 25,
    systemMemoryTotalBytes: 16 * 1024 ** 3, systemMemoryAvailableBytes: 8 * 1024 ** 3, swapUsedBytes: 0,
    status: "available", error: null, mainCpuPercent: 12.5, mainMemoryBytes: 80 * 1024 * 1024,
    processes: [], omittedAppProcessCount: 0, omittedCandidateProcessCount: 0 }],
});
performanceRecorder.count("engineEvents", 120);
performanceRecorder.count("toolEvents", 120);
performanceRecorder.duration("engineBatch", 4);
performanceRecorder.sample(Date.now(), false, { sessions: 1, messages: 120, streaming: 0 });
ipc.performanceDiagnosticsEnabled = async () => true;
ipc.performanceDiagnosticsSetEnabled = async (enabled) => enabled;
const stop = initializePerformancePreference(() => ({ sessions: 1, messages: 120, streaming: 0 }));
if (import.meta.hot) import.meta.hot.dispose(stop);

function Fixture() {
  const [open, setOpen] = useState(true);
  return <main className="p-6">
    <h1>Performance diagnostics — synthetic native data, real renderer monitor</h1>
    <button onClick={() => setOpen(true)}>Open diagnostics</button>
    {open && <PerformanceDiagnosticsDialog onClose={() => setOpen(false)} />}
  </main>;
}

void i18n.changeLanguage("zh").then(() => createRoot(document.getElementById("fixture")!).render(<Fixture />));
