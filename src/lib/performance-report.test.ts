import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPerformanceReport } from "./performance-report";

afterEach(() => vi.useRealTimers());

describe("performance report export", () => {
  it("includes renderer data when native collection fails without leaking errors", async () => {
    const report = await collectPerformanceReport(
      () => Promise.reject(new Error("/Users/private/token=secret")),
      () => Promise.resolve("1.0.8"),
    );
    expect(report.native.status).toBe("unavailable");
    expect(report.version).toBe("1.0.8");
    expect(report.renderer.scope).toBe("this-window");
    expect(JSON.stringify(report)).not.toMatch(/secret|private/);
  });

  it("bounds export wait when native IPC never settles", async () => {
    vi.useFakeTimers();
    const pending = collectPerformanceReport(() => new Promise(() => {}), () => new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(101);
    const report = await pending;
    expect(report.native.status).toBe("unavailable");
    expect(report.version).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
