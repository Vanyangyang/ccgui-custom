import { afterEach, describe, expect, it, vi } from "vitest";
import { performanceRecorder } from "./performance-diagnostics";
import { performanceMonitorCapabilities, startPerformanceMonitor } from "./performance-monitor";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("performance monitor lifecycle", () => {
  it("starts once, samples without UI subscribers, and cleans up", () => {
    vi.useFakeTimers();
    const sample = vi.spyOn(performanceRecorder, "sample");
    const context = vi.fn(() => ({ sessions: 1, messages: 500, streaming: 1 }));
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceMonitor(context);
    expect(startPerformanceMonitor(context)).toBe(stop);
    for (let tick = 0; tick < 5; tick++) {
      now += 1000;
      vi.advanceTimersByTime(1000);
    }
    expect(sample).toHaveBeenCalledTimes(1);
    expect(context).toHaveBeenCalledTimes(1);
    expect(performanceMonitorCapabilities().running).toBe(true);
    stop();
    stop();
    now += 5000;
    vi.advanceTimersByTime(5000);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(performanceMonitorCapabilities().running).toBe(false);
  });

  it("survives unavailable context and missing Long Tasks support", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stop = startPerformanceMonitor(() => { throw new Error("sensitive context"); });
    now = 5000;
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(JSON.stringify(performanceRecorder.snapshot())).not.toContain("sensitive");
    stop();
  });
});
