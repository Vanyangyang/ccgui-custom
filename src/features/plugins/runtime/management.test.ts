import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), invoke: vi.fn(), prepare: vi.fn(), refresh: vi.fn(), finish: vi.fn(), done: vi.fn(), version: vi.fn(), states: vi.fn(), unload: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { pluginList: mocks.list } }));
vi.mock("@/lib/transport", async importOriginal => ({ ...await importOriginal<object>(), invoke: mocks.invoke }));
vi.mock("@/lib/runtime-checkpoint", async importOriginal => ({ ...await importOriginal<object>(), beginRuntimeOperation: () => mocks.done }));
vi.mock("../manager/usePlugins", () => ({ refreshPluginsAfterMaintenance: mocks.refresh }));
vi.mock("./loader", () => ({ getLoadedPluginVersion: mocks.version, getPluginStatesSnapshot: mocks.states, unloadPlugin: mocks.unload }));
vi.mock("./update-close", async importOriginal => ({ ...await importOriginal<object>(), preparePluginForMaintenance: mocks.prepare }));
import { handlePluginManagementRequest as handle, isPluginManagementMethod } from "./management";
const request = { requestId: "r1", method: "reload_plugin", arguments: { id: "demo", expectedVersion: "2.0.0" } };
beforeEach(() => {
  vi.resetAllMocks(); window.location.hash = "";
  mocks.list.mockResolvedValue([{ id: "demo", version: "2.0.0", enabled: true, permissions: ["storage"] }]);
  mocks.invoke.mockResolvedValue(true); mocks.prepare.mockResolvedValue(mocks.finish);
  mocks.refresh.mockImplementation(async (_id, _request, operation) => operation());
  mocks.version.mockReturnValue("2.0.0"); mocks.states.mockReturnValue([{ id: "demo", state: "active" }]);
});
describe("plugin management requests", () => {
  it("lists and previews without synchronization or mutations", async () => {
    expect(isPluginManagementMethod("list_plugins")).toBe(true); expect(isPluginManagementMethod("send_message")).toBe(false);
    await handle({ ...request, method: "list_plugins", arguments: {} }, () => true);
    mocks.invoke.mockResolvedValue({ id: "demo", version: "3.0.0", permissions: ["storage", "chat"] });
    expect(await handle({ ...request, method: "get_plugin_status", arguments: { id: "demo", sourcePath: "source" } }, () => true)).toMatchObject({ newPermissions: ["chat"], runtime: { loadedVersion: "2.0.0" } });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("rejects expired requests and save refusal without native writes", async () => {
    mocks.invoke.mockResolvedValue(false);
    expect(await handle(request, () => true)).toMatchObject({ committed: false, error: expect.stringContaining("expired") });
    expect(mocks.invoke).toHaveBeenCalledTimes(1); expect(mocks.prepare).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue(true);
    mocks.invoke.mockClear(); mocks.prepare.mockRejectedValue(new Error("save refused"));
    expect(await handle(request, () => true)).toMatchObject({ committed: false, error: expect.stringContaining("save refused") });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it("preserves disabled state and reports actual loaded version mismatch", async () => {
    mocks.list.mockResolvedValue([{ id: "demo", version: "2.0.0", enabled: false }]);
    expect(await handle(request, () => true)).toMatchObject({ committed: true, activation: "disabled" });
    expect(mocks.invoke).toHaveBeenCalledWith("plugin_reload", { id: "demo", requestId: "r1", hostRequestId: "r1", expectedVersion: "2.0.0", preserveEnabled: true });
    mocks.list.mockResolvedValue([{ id: "demo", version: "2.0.0", enabled: true }]); mocks.version.mockReturnValue("1.0.0");
    expect(await handle(request, () => true)).toMatchObject({ committed: true, activation: "failed", runtime: { loadedVersion: "1.0.0" } });
  });
  it("never claims commit on native failure even if disk already changed", async () => {
    mocks.invoke.mockImplementation(async (command) => { if (command === "plugin_reload") throw new Error("disk partial"); return true; });
    expect(await handle(request, () => true)).toMatchObject({ committed: false, installed: { version: "2.0.0" } });
  });
  it("rejects concurrent mutation and disposals before native mutation", async () => {
    const pending = Promise.withResolvers<() => void>(); mocks.prepare.mockReturnValue(pending.promise);
    let active = true; const work = handle(request, () => active);
    await expect(handle(request, () => true)).rejects.toThrow("busy");
    active = false; pending.resolve(mocks.finish); await expect(work).rejects.toThrow("unavailable");
    expect(mocks.invoke).toHaveBeenCalledTimes(1); expect(mocks.done).toHaveBeenCalledOnce();
  });
  it("bounds preparation without cancelling or replaying a later native operation", async () => {
    vi.useFakeTimers();
    try {
      mocks.prepare.mockImplementation((_id, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
      const work = handle(request, () => true); await vi.advanceTimersByTimeAsync(20_000);
      expect(await work).toMatchObject({ committed: false, error: expect.stringContaining("timed out") });
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("checks candidate and installed versions before closing views", async () => {
    mocks.invoke.mockImplementation(async command => command === "plugin_inspect_path" ? { id: "wrong", version: "2.0.0" } : true);
    expect(await handle({ ...request, method: "install_plugin", arguments: { path: "source", expectedId: "demo", expectedVersion: "2.0.0" } }, () => true)).toMatchObject({ committed: false });
    mocks.list.mockResolvedValue([{ id: "demo", version: "1.0.0" }]);
    expect(await handle(request, () => true)).toMatchObject({ committed: false });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.unload).not.toHaveBeenCalled();
  });
  it("reports resume failure without discarding the native commit result", async () => {
    mocks.invoke.mockImplementation(async command => { if (command === "plugin_reload") throw new Error("native failed"); return true; });
    mocks.finish.mockImplementation(() => { throw new Error("resume failed"); });
    expect(await handle(request, () => true)).toMatchObject({ committed: false, error: expect.stringContaining("resume failed") });
  });
  let loader: typeof import("./loader");
  let close: typeof import("./update-close");
  let usePluginTabsStore: (typeof import("./center-tabs"))["usePluginTabsStore"];
  beforeAll(async () => {
    loader = await vi.importActual<typeof import("./loader")>("./loader");
    close = await vi.importActual<typeof import("./update-close")>("./update-close");
    ({ usePluginTabsStore } = await import("./center-tabs"));
  }, 30_000);
  it.each(["install_plugin", "reload_plugin"])("%s permits a real replacement activate to register and open its center tab", async method => {
    const manifest = { id: "demo", name: "Demo", version: "2.0.0", tier: "js" as const, permissions: ["ui:center-tab"] };
    const installed = { ...manifest, source: "builtin", enabled: true, quarantined: false, lastError: null } as import("@/lib/ipc").PluginInfo;
    const backend = { appVersion: async () => "1.0.0", list: async () => [installed], readFile: async () => "", quarantine: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}), get: async () => null, set: vi.fn(async () => {}), delete: vi.fn(async () => {}), bridgeInvoke: async () => null };
    const oldResume = vi.fn();
    const activate = (ctx: import("@ccgui/plugin-sdk").PluginContext) => {
      ctx.ui.registerCenterTab({ title: () => "Demo", component: () => null });
      ctx.ui.openCenterTab();
      ctx.ui.registerUpdateCloseHandler({ prepare: async () => {}, resume: oldResume });
    };
    try {
      if (method === "reload_plugin") await loader.loadPlugin({ info: installed, manifest, builtinActivate: activate }, backend);
      mocks.list.mockResolvedValue([installed]);
      mocks.prepare.mockImplementation(close.preparePluginForMaintenance);
      mocks.unload.mockImplementation(loader.unloadPlugin);
      mocks.version.mockImplementation(loader.getLoadedPluginVersion);
      mocks.states.mockImplementation(loader.getPluginStatesSnapshot);
      mocks.invoke.mockImplementation(async command => command === "plugin_inspect_path" ? manifest : true);
      mocks.refresh.mockImplementation(async (_id, _request, operation) => {
        await operation();
        await loader.loadPlugin({ info: installed, manifest, builtinActivate: activate }, backend);
      });
      const args = method === "install_plugin" ? { path: "source", expectedId: "demo", expectedVersion: "2.0.0" } : request.arguments;
      expect(await handle({ ...request, method, arguments: args }, () => true)).toMatchObject({ committed: true, activation: "active" });
      expect(usePluginTabsStore.getState().tabs).toContain("plugin:demo");
      expect(oldResume).not.toHaveBeenCalled(); expect(backend.quarantine).not.toHaveBeenCalled();
    } finally { loader.unloadPlugin("demo"); usePluginTabsStore.setState({ tabs: [], activeId: null }); }
  });
});
