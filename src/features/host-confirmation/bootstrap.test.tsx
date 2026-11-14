import { act } from "react";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), fonts: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/settings/font", () => ({ applyFontPreferences: mocks.fonts, readCachedFontPreferences: () => ({}) }));
import { startHostConfirmationApp } from "./bootstrap";
const content = { title: "Fixture", message: "Review", fields: [], sections: [], confirmLabel: "Confirm", dismissLabel: "Cancel", dark: true, language: "en" };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let stop: (() => void) | undefined;
afterEach(async () => { await act(async () => stop?.()); stop = undefined; document.body.innerHTML = ""; delete document.documentElement.dataset.appMounted; localStorage.clear(); vi.resetAllMocks(); });
describe("confirmation bootstrap", () => {
  it("survives the actual 8-second boot watchdog while reading, even with a historical checkpoint error", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    localStorage.setItem("ccgui:last-crash", JSON.stringify({ source: "unhandledrejection", message: "Incomplete checkpoint event bookkeeping", time: "2020-01-01T00:00:00Z" }));
    const timers: { callback: () => void; delay: number }[] = [];
    runInNewContext(readFileSync("public/boot-watchdog.js", "utf8"), {
      document, localStorage, location: { pathname: "/" },
      window: { addEventListener: vi.fn(), setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }) },
    });
    mocks.invoke.mockImplementation(async (command: string) => command === "host_confirmation_read" ? content : undefined);
    await act(async () => { stop = startHostConfirmationApp(); });
    const root = document.getElementById("root")!, rendered = [...root.childNodes];
    let afterDeadline = "";
    try {
      expect(timers.map(timer => timer.delay)).toContain(8000);
      await act(async () => { timers.filter(timer => timer.delay === 8000).forEach(timer => timer.callback()); });
      afterDeadline = root.textContent ?? "";
    } finally {
      // Keep React cleanup valid when reproducing the old watchdog DOM replacement.
      root.replaceChildren(...rendered);
    }
    expect(afterDeadline).toContain("Fixture");
    expect(afterDeadline).not.toContain("Failed to start");
    expect(afterDeadline).not.toContain("Incomplete checkpoint event bookkeeping");
    expect(mocks.invoke).not.toHaveBeenCalledWith("host_confirmation_respond", { accepted: true });
  });
  it("marks only committed content as mounted and releases the marker on teardown", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    let finishRead!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command: string) => command === "host_confirmation_read" ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve());
    await act(async () => { stop = startHostConfirmationApp(); });
    expect(document.documentElement.dataset.appMounted).toBeUndefined();
    await act(async () => finishRead(content));
    expect(document.documentElement.dataset.appMounted).toBe("1");
    await act(async () => stop?.());
    expect(document.documentElement.dataset.appMounted).toBeUndefined();
  });
  it("announces readiness only with mounted content and denies on teardown once", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "host_confirmation_read") return content;
      if (command === "host_confirmation_ready") expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    await act(async () => { stop = startHostConfirmationApp(); });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("host_confirmation_ready");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); stop?.(); });
    expect(mocks.invoke.mock.calls.filter(c => c[0] === "host_confirmation_respond")).toEqual([["host_confirmation_respond", { accepted: false }]]);
  });
  it("reports initialization failure separately from human dismissal without announcing readiness", async () => {
    mocks.invoke.mockRejectedValue(new Error("unavailable"));
    await act(async () => { stop = startHostConfirmationApp(); });
    expect(mocks.invoke).toHaveBeenCalledWith("host_confirmation_respond", { accepted: false, failed: true });
    expect(mocks.invoke).not.toHaveBeenCalledWith("host_confirmation_ready");
  });
  it("ignores a late read after disposal", async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockImplementation((command: string) => command === "host_confirmation_read" ? new Promise(r => { resolve = r; }) : Promise.resolve());
    await act(async () => { stop = startHostConfirmationApp(); stop(); resolve(content); });
    expect(mocks.invoke).not.toHaveBeenCalledWith("host_confirmation_ready");
  });
  it("fails closed if native readiness fails", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "host_confirmation_read") return content;
      if (command === "host_confirmation_ready") throw new Error("window unavailable");
    });
    await act(async () => { stop = startHostConfirmationApp(); });
    expect(mocks.invoke).toHaveBeenCalledWith("host_confirmation_respond", { accepted: false, failed: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
