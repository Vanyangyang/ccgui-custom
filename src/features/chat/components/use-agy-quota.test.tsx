import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type AgyQuotaSnapshot } from "@/lib/ipc";
import { listenAgyQuotaChanged } from "@/lib/events";
import { useAgyQuota } from "./use-agy-quota";
vi.mock("@/lib/ipc", () => ({ ipc: { agyQuotaRead: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenAgyQuotaChanged: vi.fn() }));
vi.mock("@/features/settings/providers", () => ({ CLI_CONFIG_CHANGED_EVENT: "ccgui:cli-config-changed" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const NOW = 1_900_000_000;
const quota = (usedPercentage = 20): AgyQuotaSnapshot => ({ status: "ready", collectedAt: NOW, groups: [{ id: "gemini", windows: { fiveHour: { usedPercentage } } }] });
let controls: ReturnType<typeof useAgyQuota>;
function Probe({ provider, path = "C:/project", engine = "agy" }: { provider?: string; path?: string; engine?: string }) {
  controls = useAgyQuota(engine, provider, path);
  return <span>{controls.snapshot?.groups[0]?.windows.fiveHour?.usedPercentage ?? "unknown"} {controls.snapshot?.status}</span>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
describe("AGY quota lifecycle", () => {
  let root: Root, container: HTMLDivElement, changed: () => void;
  let stop: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    stop = vi.fn();
    vi.mocked(listenAgyQuotaChanged).mockImplementation(async callback => { changed = callback; return stop; });
    vi.mocked(ipc.agyQuotaRead).mockResolvedValue(quota());
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(provider?: string, path?: string, engine?: string, strict = false) {
    await act(async () => root.render(strict ? <StrictMode><Probe provider={provider} path={path} engine={engine} /></StrictMode> : <Probe provider={provider} path={path} engine={engine} />));
  }
  it("bootstraps once through the API when startup or remount has no cached sample", async () => {
    vi.mocked(ipc.agyQuotaRead).mockResolvedValue({ status: "unavailable", groups: [], errorCode: "not_loaded" });
    await render();
    expect(controls.snapshot?.errorCode).toBe("not_loaded");
    expect(controls.loading).toBe(false);
    await act(async () => changed());
    await render(undefined, "D:/other");
    expect(vi.mocked(ipc.agyQuotaRead).mock.calls.map(([options]) => options?.cacheOnly)).toEqual([true, false, true, true, false]);
    expect(vi.mocked(ipc.agyQuotaRead).mock.calls.every(([options]) => options?.force === false)).toBe(true);
  });
  it("polls the API visibly without force and uses only cache for native events", async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(ipc.agyQuotaRead).toHaveBeenCalledTimes(2);
    expect(ipc.agyQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: false, force: false, providerId: undefined, workspacePath: "C:/project" });
    await act(async () => controls.refresh());
    expect(ipc.agyQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: false, force: true, providerId: undefined, workspacePath: "C:/project" });
    await act(async () => changed());
    expect(vi.mocked(ipc.agyQuotaRead).mock.lastCall?.[0]?.cacheOnly).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const count = vi.mocked(ipc.agyQuotaRead).mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("focus")); await controls.refresh(); await vi.advanceTimersByTimeAsync(60_000); });
    expect(ipc.agyQuotaRead).toHaveBeenCalledTimes(count);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(ipc.agyQuotaRead).toHaveBeenCalledTimes(count + 1);
    expect(ipc.agyQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: false, force: false, providerId: undefined, workspacePath: "C:/project" });
  });
  it("does not bootstrap hidden, remote, custom-provider or other-engine routes", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    vi.mocked(ipc.agyQuotaRead).mockResolvedValue({ status: "unavailable", groups: [], errorCode: "not_loaded" });
    await render();
    expect(ipc.agyQuotaRead).toHaveBeenCalledOnce();
    for (const path of ["wsl://Ubuntu/p", "ssh://host/p", "\\\\wsl.localhost\\Ubuntu\\p"]) await render(undefined, path);
    await render("custom"); await render("__agy_vertex__"); await render(undefined, undefined, "claude");
    expect(ipc.agyQuotaRead).toHaveBeenCalledOnce();
  });
  it("clears immediately on route change and ignores old replies", async () => {
    const old = deferred<AgyQuotaSnapshot>();
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(old.promise).mockResolvedValueOnce(quota(45));
    await render(); await render(undefined, "D:/other");
    await act(async () => old.resolve(quota(90)));
    expect(container.textContent).toBe("45 ready");
    await render("custom"); expect(controls.snapshot).toBeUndefined();
    expect(controls.loading).toBe(false);
  });
  it("coalesces concurrent manual refresh and cache invalidations", async () => {
    await render();
    const pending = deferred<AgyQuotaSnapshot>();
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(pending.promise);
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = controls.refresh(); second = controls.refresh(); changed(); changed(); });
    expect(ipc.agyQuotaRead).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(quota(55)); await Promise.all([first, second]); });
    expect(ipc.agyQuotaRead).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ipc.agyQuotaRead).mock.lastCall?.[0]?.cacheOnly).toBe(true);
  });
  it("runs a manual check after an automatic query that was already in flight", async () => {
    await render();
    const pending = deferred<AgyQuotaSnapshot>();
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(pending.promise);
    let manual!: Promise<void>;
    await act(async () => { window.dispatchEvent(new Event("focus")); manual = controls.refresh(); });
    expect(vi.mocked(ipc.agyQuotaRead).mock.lastCall?.[0]?.force).toBe(false);
    await act(async () => { pending.resolve(quota(30)); await manual; });
    expect(vi.mocked(ipc.agyQuotaRead).mock.lastCall?.[0]).toMatchObject({ cacheOnly: false, force: true });
  });
  it("ends a hung IPC read, allows retry, and ignores the timed-out reply", async () => {
    await render();
    const hung = deferred<AgyQuotaSnapshot>();
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(hung.promise);
    let refresh!: Promise<void>;
    await act(async () => { refresh = controls.refresh(); });
    expect(controls.loading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); await refresh; });
    expect(controls.loading).toBe(false);
    expect(controls.snapshot).toMatchObject({ status: "stale", errorCode: "read_failed" });
    vi.mocked(ipc.agyQuotaRead).mockResolvedValueOnce(quota(45));
    await act(async () => controls.refresh());
    await act(async () => hung.resolve(quota(99)));
    expect(container.textContent).toBe("45 ready");
  });
  it("does not show refreshing for cache reads and cleans a pending deadline on unmount", async () => {
    const hung = deferred<AgyQuotaSnapshot>();
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(hung.promise);
    await render();
    expect(controls.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(2);
    await render("custom");
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => hung.resolve(quota()));
    expect(controls.snapshot).toBeUndefined();
  });
  it("clears config-invalid data, ignores its pending reply and debounces refresh", async () => {
    await render();
    const pending = deferred<AgyQuotaSnapshot>();
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(pending.promise);
    let refresh!: Promise<void>;
    await act(async () => { refresh = controls.refresh(); });
    await act(async () => { window.dispatchEvent(new Event("ccgui:cli-config-changed")); window.dispatchEvent(new Event("ccgui:cli-config-changed")); });
    expect(controls.snapshot?.groups).toEqual([]);
    await act(async () => { pending.resolve(quota(90)); await refresh; });
    expect(controls.snapshot?.groups).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(ipc.agyQuotaRead).toHaveBeenCalledTimes(3);
    expect(ipc.agyQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: false, force: false, providerId: undefined, workspacePath: "C:/project" });
  });
  it("retains stale values on transport failure and reset, but honors identity invalidation", async () => {
    vi.mocked(ipc.agyQuotaRead).mockResolvedValueOnce({ ...quota(), groups: [{ id: "gemini", windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } }] });
    await render(); await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(controls.snapshot?.groups[0]?.windows.fiveHour?.usedPercentage).toBe(20);
    vi.mocked(ipc.agyQuotaRead).mockRejectedValueOnce(new Error("transport"));
    await act(async () => controls.refresh());
    expect(controls.snapshot).toMatchObject({ status: "stale", collectedAt: NOW, errorCode: "read_failed" });
    expect(controls.snapshot?.groups[0]?.windows.fiveHour?.usedPercentage).toBe(20);
    vi.mocked(ipc.agyQuotaRead).mockResolvedValueOnce({ status: "unavailable", groups: [], errorCode: "auth_changed" });
    await act(async () => changed());
    expect(controls.snapshot?.groups).toEqual([]);
  });
  it("retains idle data while hidden and cleans StrictMode subscriptions and timers", async () => {
    await render(undefined, undefined, undefined, true);
    expect(ipc.agyQuotaRead).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(controls.snapshot?.status).toBe("stale");
    await act(async () => vi.advanceTimersByTimeAsync(3_480_000));
    expect(controls.snapshot).toMatchObject({ status: "stale", collectedAt: NOW, groups: quota().groups });
    await render("custom", undefined, undefined, true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
