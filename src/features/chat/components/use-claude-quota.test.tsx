import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type ClaudeQuotaSnapshot } from "@/lib/ipc";
import { listenClaudeQuotaChanged } from "@/lib/events";
import { useClaudeQuota } from "./use-claude-quota";
vi.mock("@/lib/ipc", () => ({ ipc: { claudeQuotaRead: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenClaudeQuotaChanged: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let controls: ReturnType<typeof useClaudeQuota>;
function Probe({ provider, path = "C:/project", engine = "claude" }: { provider?: string; path?: string; engine?: string }) {
  controls = useClaudeQuota(engine, provider, path);
  return <span>{controls.snapshot?.windows.fiveHour?.usedPercentage ?? "unknown"} {controls.snapshot?.status}</span>;
}
const NOW = 1_900_000_000;
const quota = (usedPercentage = 20): ClaudeQuotaSnapshot => ({ status: "ready", collectedAt: NOW, account: { email: "reader@example.com", plan: "Claude Team" }, windows: { fiveHour: { usedPercentage } } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe("Claude quota route isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let changed: () => void;
  let stop: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    stop = vi.fn();
    vi.mocked(listenClaudeQuotaChanged).mockImplementation(async callback => { changed = callback; return stop; });
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValue(quota());
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(provider?: string, path?: string, engine?: string) { await act(async () => root.render(<Probe provider={provider} path={path} engine={engine} />)); }
  it("subscribes before its popup-independent initial cache read", async () => {
    const subscription = deferred<() => void>();
    vi.mocked(listenClaudeQuotaChanged).mockReturnValueOnce(subscription.promise);
    await render();
    expect(ipc.claudeQuotaRead).not.toHaveBeenCalled();
    await act(async () => subscription.resolve(stop));
    expect(ipc.claudeQuotaRead).toHaveBeenCalledWith({ cacheOnly: true, force: false, providerId: undefined, workspacePath: "C:/project" });
    expect(container.textContent).toBe("20 ready");
  });
  it("never actively polls: event, focus and minute refresh are cache-only", async () => {
    await render();
    await act(async () => changed());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(ipc.claudeQuotaRead).toHaveBeenCalledTimes(4);
    expect(vi.mocked(ipc.claudeQuotaRead).mock.calls.every(([options]) => options?.cacheOnly === true && options.force === false)).toBe(true);
    await act(async () => controls.refresh());
    expect(ipc.claudeQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: true, force: false, providerId: undefined, workspacePath: "C:/project" });
  });
  it("does not query custom channels, remote accounts or other engines", async () => {
    for (const path of ["wsl://Ubuntu/project", "ssh://host/project", "\\\\wsl.localhost\\Ubuntu\\project"]) await render(undefined, path);
    await render("custom-api"); await render(undefined, undefined, "codex");
    expect(ipc.claudeQuotaRead).not.toHaveBeenCalled();
    expect(listenClaudeQuotaChanged).not.toHaveBeenCalled();
  });
  it("clears on a provider switch and reads fresh cache after resetting to native", async () => {
    await render(); expect(container.textContent).toBe("20 ready");
    await render("custom-api"); expect(controls.snapshot).toBeUndefined();
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValueOnce(quota(45));
    await render("__local_settings_json__"); expect(container.textContent).toBe("45 ready");
    expect(ipc.claudeQuotaRead).toHaveBeenLastCalledWith({ cacheOnly: true, force: false, providerId: "__local_settings_json__", workspacePath: "C:/project" });
  });
  it("rejects a late native response after selecting a custom channel", async () => {
    const pending = deferred<ClaudeQuotaSnapshot>();
    vi.mocked(ipc.claudeQuotaRead).mockReturnValueOnce(pending.promise);
    await render(); await render("custom-api");
    await act(async () => pending.resolve(quota(80)));
    expect(controls.snapshot).toBeUndefined();
    expect(controls.loading).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("ignores old-route failures and new-route late successes after unmount", async () => {
    const old = deferred<ClaudeQuotaSnapshot>();
    const fresh = deferred<ClaudeQuotaSnapshot>();
    vi.mocked(ipc.claudeQuotaRead).mockReturnValueOnce(old.promise).mockResolvedValueOnce(quota(40));
    await render(); await render(undefined, "D:/other");
    await act(async () => old.reject(new Error("old failure")));
    expect(container.textContent).toBe("40 ready");
    vi.mocked(ipc.claudeQuotaRead).mockReturnValueOnce(fresh.promise);
    await act(async () => changed());
    await act(async () => root.unmount());
    await act(async () => fresh.resolve(quota(90)));
    expect(container.textContent).toBe("");
  });
  it("cleans up a late event subscription", async () => {
    const subscription = deferred<() => void>();
    vi.mocked(listenClaudeQuotaChanged).mockReturnValueOnce(subscription.promise);
    await render(); await render("custom-api");
    await act(async () => subscription.resolve(stop));
    expect(stop).toHaveBeenCalledOnce();
    expect(ipc.claudeQuotaRead).not.toHaveBeenCalled();
  });
  it("coalesces invalidations during both cache reads and active queries", async () => {
    const first = deferred<ClaudeQuotaSnapshot>();
    vi.mocked(ipc.claudeQuotaRead).mockReturnValueOnce(first.promise).mockResolvedValueOnce(quota(50));
    await render();
    await act(async () => { changed(); changed(); });
    await act(async () => first.resolve(quota(10)));
    expect(ipc.claudeQuotaRead).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("50 ready");
    const manual = deferred<ClaudeQuotaSnapshot>();
    vi.mocked(ipc.claudeQuotaRead).mockReturnValueOnce(manual.promise).mockResolvedValueOnce(quota(75));
    let refresh!: Promise<void>;
    await act(async () => { refresh = controls.refresh(); });
    await act(async () => { changed(); changed(); });
    await act(async () => { manual.resolve(quota(60)); await refresh; });
    expect(ipc.claudeQuotaRead).toHaveBeenCalledTimes(4);
    expect(vi.mocked(ipc.claudeQuotaRead).mock.calls[2][0]?.cacheOnly).toBe(true);
    expect(vi.mocked(ipc.claudeQuotaRead).mock.calls[3][0]?.cacheOnly).toBe(true);
    expect(container.textContent).toBe("75 ready");
  });
  it("keeps a missing window unavailable and uses a real zero when provided", async () => {
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValueOnce({ status: "unavailable", windows: {} });
    await render(); expect(container.textContent).toBe("unknown unavailable");
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValueOnce(quota(0));
    await act(async () => controls.refresh()); expect(container.textContent).toBe("0 ready");
  });
  it("clears the last percentages when the identity cache is no longer loaded", async () => {
    await render(); expect(container.textContent).toBe("20 ready");
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValueOnce({ status: "unavailable", windows: {}, errorCode: "not_loaded" });
    await act(async () => controls.refresh());
    expect(container.textContent).toBe("unknown unavailable");
    expect(controls.snapshot?.windows.fiveHour).toBeUndefined();
  });
  it("keeps the last percentages when a later read fails", async () => {
    await render(); expect(container.textContent).toBe("20 ready");
    expect(controls.snapshot?.account?.email).toBe("reader@example.com");
    vi.mocked(ipc.claudeQuotaRead).mockRejectedValueOnce(new Error("transport unavailable"));
    await act(async () => controls.refresh());
    expect(container.textContent).toBe("20 stale");
    expect(controls.snapshot?.collectedAt).toBe(NOW);
    expect(controls.snapshot?.account?.email).toBe("reader@example.com");
  });
  it("does not postpone a reset when the streaming parent rerenders", async () => {
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValueOnce({ ...quota(), windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await render();
    expect(container.textContent).toBe("20 ready");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.textContent).toBe("20 stale");
    expect(ipc.claudeQuotaRead).toHaveBeenCalledOnce();
  });
  it("retains native-validated stale data until a newer snapshot arrives", async () => {
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValueOnce({ ...quota(), windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } });
    await render();
    vi.mocked(ipc.claudeQuotaRead).mockResolvedValue({ ...quota(), status: "stale", errorCode: "protection_unavailable", windows: { fiveHour: { usedPercentage: 20, resetsAt: NOW + 5 } } });
    await act(async () => controls.refresh());
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(595_000));
    expect(container.textContent).toBe("20 stale");
    expect(vi.mocked(ipc.claudeQuotaRead).mock.calls.every(([options]) => options?.cacheOnly === true && options.force === false)).toBe(true);
  });
  it("keeps idle usage visibly stale beyond ten minutes and clears it at one hour without active queries", async () => {
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(601_000));
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(2_998_000));
    expect(container.textContent).toBe("20 stale");
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.textContent).toBe("20 stale");
    expect(controls.snapshot?.windows.fiveHour?.usedPercentage).toBe(20);
    expect(vi.mocked(ipc.claudeQuotaRead).mock.calls.every(([options]) => options?.cacheOnly === true)).toBe(true);
  });
});
