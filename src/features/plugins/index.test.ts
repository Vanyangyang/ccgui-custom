import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(async () => {}), stop: vi.fn(),
  bootstrap: vi.fn(async () => []), refresh: vi.fn(async () => {}),
  check: vi.fn(async () => {}),
}));
vi.mock("./manager/usePlugins", () => ({
  ensurePluginSync: mocks.ensure, stopPluginSync: mocks.stop,
  usePluginsStore: { getState: () => ({ refresh: mocks.refresh }) },
}));
vi.mock("./runtime/loader", () => ({ bootstrapPlugins: mocks.bootstrap, ipcBackend: {} }));
vi.mock("./marketplace/store", () => ({ useMarketplaceStore: { getState: () => ({ checkUpdates: mocks.check }) } }));
vi.mock("./builtin", () => ({ BUILTIN_PLUGINS: [] }));

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("plugin system lifecycle", () => {
  it("shares one subscription and update timer until the last consumer disposes", async () => {
    const { startPluginSystem } = await import("./index");
    const first = startPluginSystem();
    const second = startPluginSystem();
    await flush();
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    first();
    first();
    expect(mocks.stop).not.toHaveBeenCalled();
    second();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports StrictMode setup/cleanup/setup without a late duplicate timer", async () => {
    const { startPluginSystem } = await import("./index");
    startPluginSystem()();
    const dispose = startPluginSystem();
    await flush();
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending bootstrap retry when the application unmounts", async () => {
    mocks.bootstrap.mockRejectedValueOnce(new Error("host unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { startPluginSystem } = await import("./index");
    const dispose = startPluginSystem();
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
