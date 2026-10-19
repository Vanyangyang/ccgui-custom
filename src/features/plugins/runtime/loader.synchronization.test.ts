import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc, type PluginInfo } from "@/lib/ipc";
import {
  getPluginState, ipcBackend, loadPlugin, synchronizePlugins, unloadPlugin,
  type LoaderBackend, type LoadablePlugin,
} from "./loader";

vi.mock("@/lib/transport", () => ({ isWeb: true, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));

function plugin(overrides: Partial<PluginInfo> = {}, activate: NonNullable<LoadablePlugin["builtinActivate"]> = vi.fn()): LoadablePlugin {
  const info: PluginInfo = {
    id: "sync-plugin", name: "Sync", version: "1.0.0", description: "", author: "",
    tier: "js", source: "builtin", enabled: true, quarantined: false, lastError: null,
    permissions: [], installedAt: 1, minAppVersion: null, icon: null, screenshots: [],
    ...overrides,
  };
  return { info, manifest: { id: info.id, name: info.name, version: info.version, tier: "js", permissions: [] }, builtinActivate: activate };
}

function backend(): LoaderBackend {
  return {
    list: vi.fn(async () => []), readFile: vi.fn(async () => ""),
    quarantine: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}),
    appVersion: vi.fn(async () => "1.0.0"), get: vi.fn(async () => null),
    set: vi.fn(async () => {}), delete: vi.fn(async () => {}), bridgeInvoke: vi.fn(async () => null),
  };
}

afterEach(async () => {
  await synchronizePlugins([], [], new Set(), false, backend());
  vi.restoreAllMocks();
});

describe("host snapshot reconciliation", () => {
  it("invalidates an activation paused in appVersion when the plugin is unloaded", async () => {
    const version = Promise.withResolvers<string>();
    const activate = vi.fn();
    const host = backend();
    host.appVersion = () => version.promise;
    const builtin = plugin({}, activate);
    const pending = loadPlugin(builtin, host);
    unloadPlugin(builtin.info.id);
    version.resolve("1.0.0");
    await pending;
    expect(activate).not.toHaveBeenCalled();
    expect(getPluginState(builtin.info.id)).toBe("installed");
    expect(host.quarantine).not.toHaveBeenCalled();
  });

  it("does not publish an old manifest read after a restart snapshot deleted the plugin", async () => {
    const manifest = Promise.withResolvers<string>();
    const host = backend();
    host.readFile = vi.fn((_id: string, name: string) => name === "manifest.json" ? manifest.promise : Promise.resolve(""));
    const old = plugin({ source: "local", tier: "declarative" });
    const pending = synchronizePlugins([old.info], [], new Set(), false, host);
    await vi.waitFor(() => expect(host.readFile).toHaveBeenCalledWith(old.info.id, "manifest.json"));
    await synchronizePlugins([], [], new Set(), false, host);
    manifest.resolve(JSON.stringify({ ...old.manifest, tier: "declarative" }));
    await pending;
    expect(getPluginState(old.info.id)).toBeUndefined();
    expect(host.quarantine).not.toHaveBeenCalled();
  });

  it("does not let an invalidated load clear the guard of a newer activation", async () => {
    const oldVersion = Promise.withResolvers<string>();
    const newVersion = Promise.withResolvers<string>();
    const host = backend();
    const versionProbe = vi.fn().mockReturnValueOnce(oldVersion.promise).mockReturnValueOnce(newVersion.promise);
    host.appVersion = versionProbe;
    const activate = vi.fn();
    const builtin = plugin({}, activate);
    const old = loadPlugin(builtin, host);
    unloadPlugin(builtin.info.id);
    const current = loadPlugin(builtin, host);
    oldVersion.resolve("1.0.0");
    await old;
    await loadPlugin(builtin, host);
    expect(versionProbe).toHaveBeenCalledTimes(2);
    newVersion.resolve("1.0.0");
    await current;
    expect(activate).toHaveBeenCalledOnce();
    expect(getPluginState(builtin.info.id)).toBe("active");
  });
  it("activates once, preserves a stable snapshot, then unloads on remote disable", async () => {
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    const builtin = plugin({}, activate);
    const host = backend();
    await synchronizePlugins([builtin.info], [builtin], new Set(), false, host);
    await synchronizePlugins([builtin.info], [builtin], new Set(), false, host);
    expect(activate).toHaveBeenCalledOnce();
    await synchronizePlugins([{ ...builtin.info, enabled: false }], [builtin], new Set(), false, host);
    expect(dispose).toHaveBeenCalledOnce();
    expect(getPluginState(builtin.info.id)).toBe("installed");
    expect(host.setEnabled).not.toHaveBeenCalled();
    expect(host.quarantine).not.toHaveBeenCalled();
  });

  it("replaces an active bundle for a same-version install/reload event and reconnect", async () => {
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    const builtin = plugin({}, activate);
    const host = backend();
    await synchronizePlugins([builtin.info], [builtin], new Set(), false, host);
    await synchronizePlugins([builtin.info], [builtin], new Set([builtin.info.id]), false, host);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    await synchronizePlugins([builtin.info], [builtin], new Set(), true, host);
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it("unloads a host-quarantined plugin without persisting another quarantine", async () => {
    const dispose = vi.fn();
    const builtin = plugin({}, vi.fn(() => dispose));
    const host = backend();
    await synchronizePlugins([builtin.info], [builtin], new Set(), false, host);
    await synchronizePlugins([{ ...builtin.info, quarantined: true, lastError: "host fault" }], [builtin], new Set(), false, host);
    expect(dispose).toHaveBeenCalledOnce();
    expect(getPluginState(builtin.info.id)).toBe("quarantined");
    expect(host.quarantine).not.toHaveBeenCalled();
  });

  it("prunes an uninstalled plugin's runtime state", async () => {
    const builtin = plugin();
    const host = backend();
    await synchronizePlugins([], [builtin], new Set(), false, host);
    await synchronizePlugins([], [], new Set(), false, host);
    expect(getPluginState(builtin.info.id)).toBeUndefined();
  });

  it("keeps a browser activation failure local instead of quarantining the host", async () => {
    const nativeQuarantine = vi.spyOn(ipc, "pluginQuarantine");
    vi.spyOn(ipcBackend, "appVersion").mockResolvedValue("1.0.0");
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadPlugin(plugin({}, () => { throw new Error("browser failure"); }), ipcBackend);
    expect(getPluginState("sync-plugin")).toBe("quarantined");
    expect(nativeQuarantine).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
