import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCrashReports,
  createCrashReport,
  dismissCrash,
  formatCrashReport,
  getCrashReports,
  getCrashSnapshot,
  installGlobalCrashHandlers,
  LAST_CRASH_STORAGE_KEY,
  reportCrash,
  setCrashAppVersion,
  subscribeCrashes,
} from "./crash";

describe("crash store", () => {
  beforeEach(() => {
    localStorage.clear();
    setCrashAppVersion(undefined);
    clearCrashReports();
  });

  it("normalizes an Error and persists the latest report", () => {
    setCrashAppVersion("1.2.3");
    const report = reportCrash("render", new Error("boom"));

    expect(report.message).toBe("boom");
    expect(report.source).toBe("render");
    expect(report.appVersion).toBe("1.2.3");
    expect(getCrashSnapshot()?.id).toBe(report.id);

    const persisted = JSON.parse(localStorage.getItem(LAST_CRASH_STORAGE_KEY)!);
    expect(persisted.message).toBe("boom");
    expect(persisted.source).toBe("render");
  });

  it("accepts non-Error values", () => {
    expect(reportCrash("unhandledrejection", "plain reason").message).toBe("plain reason");
    expect(reportCrash("error", { code: 7 }).message).toBe('{"code":7}');
  });

  it("notifies subscribers and clears on dismiss without dropping history", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCrashes(listener);

    reportCrash("error", new Error("first"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCrashReports()).toHaveLength(1);

    dismissCrash();
    expect(getCrashSnapshot()).toBeNull();
    // Dismiss hides the screen; the diagnostic ring keeps the report.
    expect(getCrashReports()).toHaveLength(1);
    unsubscribe();
  });

  it("de-dupes an identical burst", () => {
    reportCrash("error", new Error("same"));
    reportCrash("error", new Error("same"));
    expect(getCrashReports()).toHaveLength(1);
  });

  it("formats a report for copying", () => {
    const report = createCrashReport("render", new Error("kaput"));
    report.stack = "Error: kaput\n    at x";
    const text = formatCrashReport(report);
    expect(text).toContain("source:  render");
    expect(text).toContain("message: kaput");
    expect(text).toContain("at x");
  });

  it("records browser noise without surfacing it as a crash", () => {
    installGlobalCrashHandlers();
    const noise = () =>
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ResizeObserver loop completed with undelivered notifications.",
        }),
      );

    noise();

    // Kept for diagnostics, flagged so a future dump can explain the absence
    // of a crash screen...
    expect(getCrashReports()).toHaveLength(1);
    expect(getCrashReports()[0]).toMatchObject({ source: "error", benign: true });
    // ...but it is not a crash: no screen, nothing for the boot watchdog.
    expect(getCrashSnapshot()).toBeNull();
    expect(localStorage.getItem(LAST_CRASH_STORAGE_KEY)).toBeNull();

    // Repeats must not crowd the ring; a real error still surfaces.
    noise();
    expect(getCrashReports()).toHaveLength(1);

    window.dispatchEvent(
      new ErrorEvent("error", { message: "Uncaught Error: boom", error: new Error("boom") }),
    );
    expect(getCrashSnapshot()?.message).toBe("boom");
    expect(getCrashSnapshot()?.benign).toBeUndefined();
    expect(getCrashReports()).toHaveLength(2);
  });

  it("records failed background network requests without surfacing a crash", () => {
    installGlobalCrashHandlers();
    const rejectWith = (reason: unknown) => {
      // jsdom has no PromiseRejectionEvent; the handler only reads `reason`.
      const event = new Event("unhandledrejection") as Event & { reason: unknown };
      event.reason = reason;
      window.dispatchEvent(event);
    };

    // The updater check failing while offline (reqwest's exact wording) is an
    // environment condition, not an app crash.
    rejectWith(
      "error sending request for url (https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases/latest/download/latest.json)",
    );
    rejectWith(new TypeError("Load failed"));

    expect(getCrashReports()).toHaveLength(2);
    expect(getCrashReports()[0]).toMatchObject({ source: "unhandledrejection", benign: true });
    expect(getCrashReports()[1]).toMatchObject({ source: "unhandledrejection", benign: true });
    expect(getCrashSnapshot()).toBeNull();
    expect(localStorage.getItem(LAST_CRASH_STORAGE_KEY)).toBeNull();

    // A real rejection still puts up the crash screen.
    rejectWith(new Error("boom"));
    expect(getCrashSnapshot()?.message).toBe("boom");
    expect(getCrashSnapshot()?.benign).toBeUndefined();
  });
});
