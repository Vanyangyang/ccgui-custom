import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type CodexQuotaSnapshot } from "@/lib/ipc";
import { listenCodexQuotaChanged, listenTransportConnected } from "@/lib/events";
import { useCodexQuota } from "./use-codex-quota";
vi.mock("@/lib/ipc", () => ({ ipc: { codexQuotaRead: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenCodexQuotaChanged: vi.fn(), listenTransportConnected: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let controls: ReturnType<typeof useCodexQuota>;
function Probe({ provider, path = "C:/project", engine = "codex" }: { provider?: string; path?: string; engine?: string }) {
  controls = useCodexQuota(engine, provider, path);
  return <span>{controls.snapshot?.windows.fiveHour?.usedPercentage ?? "unknown"} {controls.snapshot?.status}</span>;
}
const NOW = 1_900_000_000;
const quota = (usedPercentage = 20): CodexQuotaSnapshot => ({ status: "ready", collectedAt: NOW, account: { email: "reader@example.com", plan: "Codex Team" }, windows: { fiveHour: { usedPercentage } } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe("Codex quota route isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let changed: () => void;
  let connected: () => void;
  let stop: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    stop = vi.fn();
    vi.mocked(listenCodexQuotaChanged).mockImplementation(async callback => { changed = callback; return stop; });
    vi.mocked(listenTransportConnected).mockImplementation(async callback => { connected = callback; return vi.fn(); });
    vi.mocked(ipc.codexQuotaRead).mockResolvedValue(quota());
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(provider?: string, path?: string, engine?: string) { await act(async () => root.render(<Probe provider={provider} path={path} engine={engine} />)); }
  it("subscribes before its popup-independent initial cache read", async () => {
    const subscription = deferred<() => void>();
    vi.mocked(listenCodexQuotaChanged).mockReturnValueOnce(subscription.promise);
    await render();
    expect(ipc.codexQuotaRead).not.toHaveBeenCalled();
    await act(async () => subscription.resolve(stop));
    expect(ipc.codexQuotaRead).toHaveBeenCalledWith({ cacheOnly: true, force: false, providerId: undefined, workspacePath: "C:/project" });
    expect(container.textContent).toBe("20 ready");
  });
  it("never actively polls: event, focus and minute refresh are cache-only", async () => {
    await render();
    await act(async () => changed());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(ipc.codexQuotaRead).toHaveBeenCalledTimes(4);
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.every(([options]) => options?.cacheOnly === true && options.force === false)).toBe(true);
    await act(async () => controls.refresh());
    expect(ipc.codexQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: false, force: true, providerId: undefined, workspacePath: "C:/project" });
  });
  it("bootstraps only an explicitly missing initial cache once", async () => {
    vi.mocked(ipc.codexQuotaRead).mockResolvedValue({ status: "unavailable", windows: {}, errorCode: "not_loaded" });
    await render();
    expect(ipc.codexQuotaRead).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.map(([options]) => options?.cacheOnly)).toEqual([true, false]);
    await act(async () => { changed(); window.dispatchEvent(new Event("focus")); });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.filter(([options]) => options?.cacheOnly === false)).toHaveLength(1);
  });
  it("does not bootstrap authentication failures or stale caches", async () => {
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce({ status: "unavailable", windows: {}, errorCode: "auth_metadata_unavailable" });
    await render();
    expect(ipc.codexQuotaRead).toHaveBeenCalledOnce();
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce({ ...quota(), status: "stale" });
    await render(undefined, "D:/other");
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.every(([options]) => options?.cacheOnly)).toBe(true);
  });
  it("revalidates a newly missing native cache after a previously successful session without polling", async () => {
    await render();
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce({status:"unavailable",windows:{},errorCode:"not_loaded"}).mockResolvedValueOnce(quota(45));
    await act(async()=>changed());
    expect(container.textContent).toBe("45 ready");
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.map(([options])=>options?.cacheOnly)).toEqual([true,true,false]);
    await act(async()=>changed());
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.filter(([options])=>options?.cacheOnly===false)).toHaveLength(1);
  });
  it("reconciles validated cache on reconnect after an IPC failure", async () => {
    await render();
    vi.mocked(ipc.codexQuotaRead).mockRejectedValueOnce(new Error("disconnected"));
    await act(async()=>changed());
    expect(controls.snapshot?.account).toBeUndefined();
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce(quota(45));
    await act(async()=>connected());
    expect(container.textContent).toBe("45 ready");
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.every(([options])=>options?.cacheOnly)).toBe(true);
  });
  it("does not query custom channels, remote accounts or other engines", async () => {
    for (const path of ["wsl://Ubuntu/project", "ssh://host/project", "\\\\wsl.localhost\\Ubuntu\\project"]) await render(undefined, path);
    await render("custom-api"); await render(undefined, undefined, "claude");
    expect(ipc.codexQuotaRead).not.toHaveBeenCalled();
    expect(listenCodexQuotaChanged).not.toHaveBeenCalled();
  });
  it("clears on a provider switch and reads fresh cache after resetting to native", async () => {
    await render(); expect(container.textContent).toBe("20 ready");
    await render("custom-api"); expect(controls.snapshot).toBeUndefined();
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce(quota(45));
    await render("__local_settings_json__"); expect(container.textContent).toBe("45 ready");
    expect(ipc.codexQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: true, force: false, providerId: "__local_settings_json__", workspacePath: "C:/project" });
  });
  it("rejects a late native response after selecting a custom channel", async () => {
    const pending = deferred<CodexQuotaSnapshot>();
    vi.mocked(ipc.codexQuotaRead).mockReturnValueOnce(pending.promise);
    await render(); await render("custom-api");
    await act(async () => pending.resolve(quota(80)));
    expect(controls.snapshot).toBeUndefined();
    expect(controls.loading).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("ignores old-route failures and new-route late successes after unmount", async () => {
    const old = deferred<CodexQuotaSnapshot>();
    const fresh = deferred<CodexQuotaSnapshot>();
    vi.mocked(ipc.codexQuotaRead).mockReturnValueOnce(old.promise).mockResolvedValueOnce(quota(40));
    await render(); await render(undefined, "D:/other");
    await act(async () => old.reject(new Error("old failure")));
    expect(container.textContent).toBe("40 ready");
    vi.mocked(ipc.codexQuotaRead).mockReturnValueOnce(fresh.promise);
    await act(async () => changed());
    await act(async () => root.unmount());
    await act(async () => fresh.resolve(quota(90)));
    expect(container.textContent).toBe("");
  });
  it("cleans up a late event subscription", async () => {
    const subscription = deferred<() => void>();
    vi.mocked(listenCodexQuotaChanged).mockReturnValueOnce(subscription.promise);
    await render(); await render("custom-api");
    await act(async () => subscription.resolve(stop));
    expect(stop).toHaveBeenCalledOnce();
    expect(ipc.codexQuotaRead).not.toHaveBeenCalled();
  });
  it("coalesces invalidations during both cache reads and active queries", async () => {
    const first = deferred<CodexQuotaSnapshot>();
    vi.mocked(ipc.codexQuotaRead).mockReturnValueOnce(first.promise).mockResolvedValueOnce(quota(50));
    await render();
    await act(async () => { changed(); changed(); });
    await act(async () => first.resolve(quota(10)));
    expect(ipc.codexQuotaRead).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("50 ready");
    const manual = deferred<CodexQuotaSnapshot>();
    vi.mocked(ipc.codexQuotaRead).mockReturnValueOnce(manual.promise).mockResolvedValueOnce(quota(75));
    let refresh!: Promise<void>;
    await act(async () => { refresh = controls.refresh(); });
    await act(async () => { changed(); changed(); });
    await act(async () => { manual.resolve(quota(60)); await refresh; });
    expect(ipc.codexQuotaRead).toHaveBeenCalledTimes(4);
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls[2][0]?.cacheOnly).toBe(false);
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls[3][0]?.cacheOnly).toBe(true);
    expect(container.textContent).toBe("75 ready");
  });
  it("keeps a missing window unavailable and uses a real zero when provided", async () => {
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce({ status: "unavailable", windows: {} });
    await render(); expect(container.textContent).toBe("unknown unavailable");
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce(quota(0));
    await act(async () => controls.refresh()); expect(container.textContent).toBe("0 ready");
  });
  it("drops previous percentages when IPC cannot revalidate the account", async () => {
    await render(); expect(container.textContent).toBe("20 ready");
    expect(controls.snapshot?.account?.email).toBe("reader@example.com");
    vi.mocked(ipc.codexQuotaRead).mockRejectedValueOnce(new Error("transport unavailable"));
    await act(async () => controls.refresh());
    expect(container.textContent).toBe("unknown unavailable");
    expect(controls.snapshot?.collectedAt).toBeUndefined();
    expect(controls.snapshot?.account).toBeUndefined();
  });
  it("does not postpone a reset when the streaming parent rerenders", async () => {
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce({ ...quota(), windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await render();
    expect(container.textContent).toBe("20 ready");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.textContent).toBe("unknown unavailable");
    expect(ipc.codexQuotaRead).toHaveBeenCalledOnce();
  });
  it("retains native-validated stale data, expires reset windows and clears old cache", async () => {
    vi.mocked(ipc.codexQuotaRead).mockResolvedValueOnce({ ...quota(), windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } });
    await render();
    vi.mocked(ipc.codexQuotaRead).mockResolvedValue({ ...quota(), status: "stale", errorCode: "protection_unavailable", windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } });
    await act(async () => controls.refresh());
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toBe("unknown unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(595_000));
    expect(container.textContent).toBe("unknown unavailable");
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.filter(([options]) => options?.cacheOnly === false)).toHaveLength(1);
  });
  it("keeps idle usage visibly stale beyond ten minutes and clears it at one hour without active queries", async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(601_000));
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(2_998_000));
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.textContent).toBe("unknown unavailable");
    expect(controls.snapshot?.errorCode).toBe("quota_expired");
    expect(vi.mocked(ipc.codexQuotaRead).mock.calls.every(([options]) => options?.cacheOnly === true)).toBe(true);
  });
});
