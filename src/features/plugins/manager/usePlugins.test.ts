import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/ipc";
import type { PluginInstallProgress } from "@/lib/events";

const pluginList = vi.fn(async (): Promise<PluginInfo[]> => []);
const pluginInstallFromPath = vi.fn();
const pluginSetEnabled = vi.fn(async (id: string, enabled: boolean) =>
  info({ id, enabled, quarantined: false, lastError: null }),
);
const pluginUninstall = vi.fn(async (_id: string, _deleteData: boolean) => {});
const pluginReload = vi.fn(async (_command: string, _args: unknown) => info());
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@/lib/transport", () => ({
  isWeb: true,
  invoke: (command: string, args: unknown) => pluginReload(command, args),
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    pluginList: () => pluginList(),
    pluginInstallFromPath: (path: string, requestId?: string) => pluginInstallFromPath(path, requestId),
    pluginSetEnabled: (id: string, enabled: boolean) => pluginSetEnabled(id, enabled),
    pluginUninstall: (id: string, deleteData: boolean) => pluginUninstall(id, deleteData),
  },
}));

const pickDirectory = vi.fn(async (_title: string): Promise<string | null> => "/tmp/plugin");
vi.mock("@/lib/platform", () => ({
  pickDirectory: (title: string) => pickDirectory(title),
}));

let progressCb: ((p: PluginInstallProgress) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@/lib/events", () => ({
  listenPluginInstallProgress: vi.fn(async (cb: (p: PluginInstallProgress) => void) => {
    progressCb = cb;
    return unlisten;
  }),
}));

const synchronizePlugins = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../runtime/loader", () => ({
  bootstrapPlugins: vi.fn(async () => []),
  getPluginStatesSnapshot: () => [],
  ipcBackend: {},
  synchronizePlugins: (...args: unknown[]) => synchronizePlugins(...args),
  // Already bootstrapped: refresh() under test never re-kicks bootstrap.
  pluginsBootstrapped: () => true,
  prunePluginRuntimeState: vi.fn(),
  subscribePluginStates: () => () => {},
  unloadPlugin: vi.fn(),
}));

vi.mock("../builtin", () => ({ BUILTIN_PLUGINS: [] }));
vi.mock("../marketplace/store", () => ({ useMarketplaceStore: { getState: () => ({ checkUpdates: vi.fn() }) } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));

// vi.mock calls above are hoisted, so this static import sees the mocks.
import { stopPluginSync, usePluginsStore } from "./usePlugins";

function info(over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "",
    author: "",
    tier: "js",
    source: "local",
    enabled: true,
    quarantined: false,
    lastError: null,
    permissions: [],
    installedAt: 0,
    minAppVersion: null,
    icon: null,
    screenshots: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  progressCb = null;
  usePluginsStore.setState({ installed: [], loaded: false, error: null, installing: null });
});

describe("installFromDirectory", () => {
  it("tracks copy progress and clears it when the install resolves", async () => {
    const gate = Promise.withResolvers<PluginInfo>();
    pluginInstallFromPath.mockReturnValue(gate.promise);

    const pending = usePluginsStore.getState().installFromDirectory();
    await vi.waitFor(() => expect(progressCb).not.toBeNull());
    expect(usePluginsStore.getState().installing).toEqual({ done: 0, total: 0 });

    const requestId = pluginInstallFromPath.mock.calls[0][1];
    progressCb!({ done: 90, total: 100, finished: false, requestId: "other-device" });
    progressCb!({ done: 90, total: 100, finished: false });
    expect(usePluginsStore.getState().installing).toEqual({ done: 0, total: 0 });
    progressCb!({ done: 5, total: 10, finished: false, requestId });
    expect(usePluginsStore.getState().installing).toEqual({ done: 5, total: 10 });

    gate.resolve(info());
    await pending;
    expect(usePluginsStore.getState().installing).toBeNull();
    expect(unlisten).toHaveBeenCalledOnce();
    // Local install over an existing id must hot-reload too (same
    // already-active no-op bug as the marketplace update path).
    expect(synchronizePlugins).toHaveBeenCalled();
    expect(pluginList).toHaveBeenCalled();
  });

  it("clears the installing state and surfaces the error when install fails", async () => {
    pluginInstallFromPath.mockRejectedValue(new Error("bad manifest"));

    await usePluginsStore.getState().installFromDirectory();

    expect(usePluginsStore.getState().installing).toBeNull();
    expect(usePluginsStore.getState().error).toContain("bad manifest");
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("does nothing when the picker is cancelled", async () => {
    pickDirectory.mockResolvedValueOnce(null);

    await usePluginsStore.getState().installFromDirectory();

    expect(usePluginsStore.getState().installing).toBeNull();
    expect(pluginInstallFromPath).not.toHaveBeenCalled();
  });
});

describe("retry", () => {
  it("clears the quarantine through the backend and reloads in place", async () => {
    pluginReload.mockResolvedValueOnce(info({ quarantined: false, lastError: null }));

    await usePluginsStore
      .getState()
      .retry(info({ quarantined: true, lastError: "Importing a module script failed." }));

    // Re-enabling is the backend's "trust it again" upsert (it clears
    // quarantined + lastError), so the retry path must go through it.
    expect(pluginReload).toHaveBeenCalledWith("plugin_reload", { id: "p" });
    expect(pluginSetEnabled).not.toHaveBeenCalled();
    expect(pluginList).toHaveBeenCalled();
  });

  it("surfaces a backend failure without touching the loader", async () => {
    pluginReload.mockRejectedValueOnce(new Error("no such plugin"));

    await usePluginsStore.getState().retry(info({ quarantined: true }));

    expect(synchronizePlugins).not.toHaveBeenCalled();
    expect(usePluginsStore.getState().error).toContain("no such plugin");
  });
});

describe("shared host changes", () => {
  it("drops a stale snapshot if a disable arrives during the list read", async () => {
    await usePluginsStore.getState().refresh();
    vi.clearAllMocks();
    const gate = Promise.withResolvers<PluginInfo[]>();
    pluginList.mockReturnValueOnce(gate.promise).mockResolvedValueOnce([info({ enabled: false })]);
    const pending = usePluginsStore.getState().refresh();
    await vi.waitFor(() => expect(pluginList).toHaveBeenCalledOnce());
    listeners.get("plugins://changed")!({ payload: { id: "p", reload: true } });
    gate.resolve([info()]);
    await pending;
    expect(synchronizePlugins).toHaveBeenCalledOnce();
    expect(synchronizePlugins).toHaveBeenCalledWith([info({ enabled: false })], [], new Set(["p"]), false);
  });
  it("reconciles an external install with a reload hint without writing host state", async () => {
    await usePluginsStore.getState().refresh();
    vi.clearAllMocks();
    pluginList.mockResolvedValueOnce([info()]);
    listeners.get("plugins://changed")!({ payload: { id: "p", reload: true } });
    await vi.waitFor(() => expect(usePluginsStore.getState().installed).toHaveLength(1));
    expect(synchronizePlugins).toHaveBeenCalledWith([info()], [], new Set(["p"]), false);
    expect(pluginSetEnabled).not.toHaveBeenCalled();
    expect(pluginInstallFromPath).not.toHaveBeenCalled();
  });

  it("reads the current host state and replaces bundles after a reconnect", async () => {
    await usePluginsStore.getState().refresh();
    vi.clearAllMocks();
    listeners.get("transport://connected")!({ payload: null });
    await vi.waitFor(() => expect(synchronizePlugins).toHaveBeenCalled());
    expect(synchronizePlugins).toHaveBeenCalledWith([], [], new Set(), true);
  });

  it("keeps an event reload pending when a snapshot read fails", async () => {
    await usePluginsStore.getState().refresh();
    pluginList.mockRejectedValueOnce(new Error("disconnected"));
    listeners.get("plugins://changed")!({ payload: { id: "p", reload: true } });
    await vi.waitFor(() => expect(usePluginsStore.getState().error).toContain("disconnected"));
    vi.clearAllMocks();
    await usePluginsStore.getState().refresh();
    expect(synchronizePlugins).toHaveBeenCalledWith([], [], new Set(["p"]), false);
  });

  it("preserves an operation error while a partial-failure event refreshes the snapshot", async () => {
    await usePluginsStore.getState().refresh();
    usePluginsStore.setState({ error: "write failed" });
    listeners.get("plugins://changed")!({ payload: { id: "p", reload: false } });
    await vi.waitFor(() => expect(synchronizePlugins).toHaveBeenCalled());
    expect(usePluginsStore.getState().error).toBe("write failed");
  });

  it("removes the global subscriptions on disposal and restores them on restart", async () => {
    await usePluginsStore.getState().refresh();
    expect(listeners.has("plugins://changed")).toBe(true);
    stopPluginSync();
    expect(listeners.size).toBe(0);
    await usePluginsStore.getState().refresh();
    expect(listeners.has("plugins://changed")).toBe(true);
    expect(listeners.has("transport://connected")).toBe(true);
  });
});
