import { performanceRecorder, type PerformanceContext } from "./performance-diagnostics";

let stopMonitor: (() => void) | undefined;
let longTasksSupported = false;

export function performanceMonitorCapabilities() {
  return { running: Boolean(stopMonitor), longTasksSupported };
}

export function startPerformanceMonitor(context: () => PerformanceContext) {
  if (stopMonitor) return stopMonitor;
  let sampledAt = performance.now();
  performanceRecorder.heartbeat(sampledAt, document.hidden);
  const visibility = () => performanceRecorder.heartbeat(performance.now(), true);
  document.addEventListener("visibilitychange", visibility);
  const timer = window.setInterval(() => {
    const now = performance.now();
    performanceRecorder.heartbeat(now, document.hidden);
    if (now - sampledAt >= 5000) {
      let counts: PerformanceContext | undefined;
      try { counts = context(); } catch { counts = undefined; }
      performanceRecorder.sample(Date.now(), document.hidden, counts);
      sampledAt = now;
    }
  }, 1000);
  let observer: PerformanceObserver | undefined;
  longTasksSupported = false;
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) performanceRecorder.duration("longTask", entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
      longTasksSupported = true;
    } catch { observer?.disconnect(); }
  }
  const stop = () => {
    if (stopMonitor !== stop) return;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", visibility);
    observer?.disconnect();
    stopMonitor = undefined;
  };
  stopMonitor = stop;
  return stop;
}
