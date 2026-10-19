import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializePerformancePreference, setPerformanceEnabled, getPerformancePreference, synchronizePerformancePreference } from "./performance-preference";
import { performanceRecorder } from "./performance-diagnostics";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), listen: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: { performanceDiagnosticsEnabled: mocks.get, performanceDiagnosticsSetEnabled: mocks.set } }));
vi.mock("./transport", () => ({ listen: mocks.listen }));
vi.mock("./performance-monitor", () => ({ startPerformanceMonitor: mocks.start }));
let dispose: (() => void) | undefined;
beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(true);
  mocks.set.mockReset().mockImplementation(async (enabled: boolean) => enabled);
  mocks.listen.mockReset().mockResolvedValue(() => {});
  mocks.start.mockReset().mockReturnValue(mocks.stop);
  mocks.stop.mockReset();
});
afterEach(() => { dispose?.(); performanceRecorder.setEnabled(true); });
const context = () => ({ sessions: 1, messages: 2, streaming: 0 });
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };

describe("persistent diagnostic preference", () => {
  it("waits for native preference then starts default-on sampling", async () => {
    dispose = initializePerformancePreference(context);
    expect(mocks.start).not.toHaveBeenCalled();
    await settle();
    expect(getPerformancePreference()).toBe(true);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it("restores disabled preference without starting and can re-enable", async () => {
    mocks.get.mockResolvedValue(false);
    dispose = initializePerformancePreference(context);
    await settle();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(getPerformancePreference()).toBe(false);
    await setPerformanceEnabled(true);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    performanceRecorder.count("engineEvents", 7);
    await setPerformanceEnabled(false);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(performanceRecorder.snapshot().pending.counters).toEqual({});
  });
  it("keeps enabled state on save failure", async () => {
    dispose = initializePerformancePreference(context);
    await settle();
    mocks.set.mockRejectedValue(new Error("save failed"));
    await expect(setPerformanceEnabled(false)).rejects.toThrow();
    expect(getPerformancePreference()).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("stops on another window's change and ignores an older startup response", async () => {
    let resolve!: (enabled: boolean) => void;
    mocks.get.mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    dispose = initializePerformancePreference(context);
    await settle();
    const callback = mocks.listen.mock.calls[0][1];
    callback({ payload: { enabled: false } });
    resolve(true);
    await settle();
    expect(getPerformancePreference()).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not restart after unmount while subscription is still loading", async () => {
    let resolve!: (remove: () => void) => void;
    const remove = vi.fn();
    mocks.listen.mockReturnValue(new Promise<() => void>((done) => { resolve = done; }));
    dispose = initializePerformancePreference(context);
    dispose();
    resolve(remove);
    await settle();
    expect(remove).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("does not apply an old enable response over a newer disable event", async () => {
    mocks.get.mockResolvedValue(false);
    dispose = initializePerformancePreference(context);
    await settle();
    let resolve!: (enabled: boolean) => void;
    mocks.set.mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    const saving = setPerformanceEnabled(true);
    mocks.listen.mock.calls[0][1]({ payload: { enabled: false } });
    resolve(true);
    await saving;
    expect(getPerformancePreference()).toBe(false);
    expect(performanceRecorder.isEnabled()).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("ignores a preference write response after disposal", async () => {
    mocks.get.mockResolvedValue(false);
    dispose = initializePerformancePreference(context);
    await settle();
    let resolve!: (enabled: boolean) => void;
    mocks.set.mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    const saving = setPerformanceEnabled(true);
    dispose();
    resolve(true);
    await saving;
    expect(performanceRecorder.isEnabled()).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("can retry a failed preference read without restarting the app", async () => {
    mocks.get.mockRejectedValueOnce(new Error("temporarily disconnected")).mockResolvedValueOnce(true);
    dispose = initializePerformancePreference(context);
    await settle();
    expect(getPerformancePreference()).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
    await synchronizePerformancePreference();
    expect(getPerformancePreference()).toBe(true);
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
