import { performanceRecorder } from "./performance-diagnostics";
import { performanceMonitorCapabilities } from "./performance-monitor";

async function bounded<T>(load: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(load).catch(() => null),
      new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { clearTimeout(timeout); }
}

export async function collectPerformanceReport<T>(
  loadNative: () => Promise<T>,
  loadVersion: () => Promise<string | null>,
  timeoutMs = 2500,
) {
  const [native, version] = await Promise.all([bounded(loadNative, timeoutMs), bounded(loadVersion, timeoutMs)]);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version,
    buildMode: import.meta.env.PROD ? "production" : "development",
    native: native == null ? { status: "unavailable" as const } : { status: "available" as const, data: native },
    renderer: { ...performanceRecorder.snapshot(), ...performanceMonitorCapabilities() },
    notes: [
      "Local numeric diagnostics only; no conversation, source code, paths, arguments or credentials.",
      "When contextAvailable is false, context counts are placeholders, not measured empty state.",
      "Process CPU percent uses one logical core as 100%; systemCpuPercent uses a whole-machine 0-100 scale. Neither is GPU utilization.",
      "Active live text lengths count UTF-16 units in at most the latest eight active-session messages, not full historical content.",
      "toolEvents includes tool-start, argument and result messages; it does not count distinct tools or edited files.",
      "WebKit candidates are not necessarily owned by this app; absence is not evidence of zero GPU load.",
      "Renderer history covers this window lifetime only; background timer throttling is excluded from event-loop lag.",
      "Long Tasks availability is reported explicitly; liveRenderCommit is elapsed render-to-layout-effect time, not pure parsing CPU time.",
      "Sleep, system-wide load and scheduling can affect timer delay; it is not proof of a JavaScript bottleneck.",
    ],
  };
}
