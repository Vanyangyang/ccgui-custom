import { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import watchdog from "../../../public/boot-watchdog.js?raw";

const fixture = vi.hoisted(() => ({ failRender: false, mainImport: vi.fn(), settings: vi.fn(), listen: vi.fn() }));
vi.mock("./AssistantNoticesOverlay", () => ({ AssistantNoticesOverlay: () => {
  if (fixture.failRender) throw new Error("Overlay render failed");
  return <article data-notice>Notice remains visible</article>;
} }));
vi.mock("@/components/crash/CrashScreen", () => ({ CrashScreen: ({ report }: { report: { message: string } }) => <div data-crash>{report.message}</div> }));
vi.mock("@/bootstrap", () => { fixture.mainImport(); return {}; });
vi.mock("@/features/chat/store", () => { fixture.mainImport(); return {}; });
vi.mock("@/features/plugins", () => { fixture.mainImport(); return {}; });
vi.mock("@/lib/live-update-bootstrap", () => { fixture.mainImport(); return {}; });
vi.mock("@/lib/ipc", () => ({ ipc: { refreshAppSettings: fixture.settings } }));
vi.mock("@/lib/transport", () => ({ listen: fixture.listen }));
vi.mock("@/lib/i18n", () => ({ default: { language: "en", changeLanguage: vi.fn() } }));
vi.mock("@/features/settings/theme", () => ({ applyTheme: vi.fn(), THEME_STORAGE_KEY: "test-theme" }));
vi.mock("@/features/settings/font", () => ({ applyFontPreferences: vi.fn(), readCachedFontPreferences: () => ({}) }));
vi.mock("@/lib/tauri-unlisten-guard", () => ({ installTauriUnlistenGuard: vi.fn() }));
import { startAssistantNoticesApp } from "./bootstrap";
import { dismissCrash } from "@/lib/crash";
import { applyTheme } from "@/features/settings/theme";
import { applyFontPreferences } from "@/features/settings/font";
import i18n from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let stop: (() => void) | undefined;
let watchdogError: EventListener | undefined;
beforeEach(() => {
  vi.useFakeTimers(); fixture.failRender = false;
  fixture.settings.mockReset().mockResolvedValue({ theme: "dark", language: "en" });
  fixture.listen.mockReset().mockResolvedValue(vi.fn());
  document.body.innerHTML = '<div id="root">Loading</div>';
  delete document.documentElement.dataset.appMounted;
  localStorage.clear(); dismissCrash();
  const events = vi.spyOn(window, "addEventListener");
  // Execute the shipped pre-module watchdog, including its actual 8s timeout.
  new Function(watchdog)();
  watchdogError = events.mock.calls.find(([name]) => name === "error")?.[1] as EventListener | undefined;
  events.mockRestore();
});
afterEach(async () => {
  await act(async () => { stop?.(); }); stop = undefined;
  if (watchdogError) window.removeEventListener("error", watchdogError);
  delete (window as Window & { __ccguiShowBootFailure?: unknown }).__ccguiShowBootFailure;
  dismissCrash(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = ""; delete document.documentElement.dataset.appMounted;
});

it("marks the first committed overlay and keeps its cards after the real watchdog deadline", async () => {
  await act(async () => {
    stop = startAssistantNoticesApp();
    expect(document.documentElement.dataset.appMounted).toBeUndefined();
  });
  expect(document.documentElement.dataset.appMounted).toBe("1");
  const notice = document.querySelector("[data-notice]");
  expect(notice).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
  expect(document.querySelector("[data-notice]")).toBe(notice);
  expect(document.querySelector(".boot-failure")).toBeNull();
  expect(fixture.mainImport).not.toHaveBeenCalled();
});

it("leaves the watchdog armed when creating the React root fails", async () => {
  vi.spyOn(ReactDOM, "createRoot").mockImplementationOnce(() => { throw new Error("Cannot mount overlay"); });
  expect(() => startAssistantNoticesApp()).toThrow("Cannot mount overlay");
  expect(document.documentElement.dataset.appMounted).toBeUndefined();
  await vi.advanceTimersByTimeAsync(8100);
  expect(document.querySelector(".boot-failure")).not.toBeNull();
});

it("keeps the committed crash surface when overlay rendering fails", async () => {
  fixture.failRender = true; vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => { stop = startAssistantNoticesApp(); });
  expect(document.querySelector("[data-crash]")?.textContent).toContain("Overlay render failed");
  await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
  expect(document.querySelector("[data-crash]")).not.toBeNull();
  expect(document.querySelector(".boot-failure")).toBeNull();
});

it("follows settings events and ignores stale reads and post-unmount responses", async () => {
  let changed!: () => void;
  const unlisten = vi.fn();
  fixture.listen.mockImplementation(async (_event: string, callback: () => void) => { changed = callback; return unlisten; });
  await act(async () => { stop = startAssistantNoticesApp(); });
  const older = Promise.withResolvers<unknown>();
  fixture.settings.mockReturnValueOnce(older.promise);
  await act(async () => changed());
  fixture.settings.mockResolvedValueOnce({ theme: "light", language: "zh", fontFamily: "custom", fontFile: "font.woff2" });
  await act(async () => changed());
  expect(applyTheme).toHaveBeenLastCalledWith("light");
  expect(applyFontPreferences).toHaveBeenLastCalledWith({ fontFamily: "custom", fontFile: "font.woff2", codeFontFamily: "", codeFontFile: "" });
  expect(i18n.changeLanguage).toHaveBeenLastCalledWith("zh");
  await act(async () => older.resolve({ theme: "dark", language: "en" }));
  expect(applyTheme).toHaveBeenLastCalledWith("light");
  const late = Promise.withResolvers<unknown>(); fixture.settings.mockReturnValueOnce(late.promise);
  await act(async () => changed());
  await act(async () => stop?.());
  await act(async () => late.resolve({ theme: "dark" }));
  expect(applyTheme).toHaveBeenLastCalledWith("light");
  expect(unlisten).toHaveBeenCalledOnce();
  expect(fixture.mainImport).not.toHaveBeenCalled();
});

it("releases a settings listener that finishes registering after disposal", async () => {
  const pending = Promise.withResolvers<() => void>(); const unlisten = vi.fn();
  fixture.listen.mockReturnValueOnce(pending.promise);
  await act(async () => { stop = startAssistantNoticesApp(); });
  await act(async () => stop?.());
  await act(async () => pending.resolve(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
});
