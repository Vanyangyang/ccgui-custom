import { expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/ipc";
import type { PluginInstallProgress } from "@/lib/events";

const progress = new Set<(event: PluginInstallProgress) => void>();
const installLocal = vi.fn();
const installMarket = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: {
  pluginList: vi.fn(async () => []), pluginCheckUpdates: vi.fn(async () => []),
  pluginInstallFromPath: (path: string, requestId?: string) => installLocal(path, requestId),
  pluginInstallFromMarketplace: (id: string, requestId?: string) => installMarket(id, requestId),
} }));
vi.mock("@/lib/transport", () => ({ isWeb: true, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/platform", () => ({ pickDirectory: vi.fn(async () => "C:/host/plugin") }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/events", () => ({ listenPluginInstallProgress: vi.fn(async (callback: (event: PluginInstallProgress) => void) => {
  progress.add(callback);
  return () => progress.delete(callback);
}) }));
vi.mock("../builtin", () => ({ BUILTIN_PLUGINS: [] }));
vi.mock("../runtime/loader", () => ({
  ipcBackend: {}, pluginsBootstrapped: () => true, synchronizePlugins: vi.fn(async () => {}),
  getPluginStatesSnapshot: () => [], subscribePluginStates: () => () => {}, bootstrapPlugins: vi.fn(async () => []),
}));

import { stopPluginSync, usePluginsStore } from "./usePlugins";
import { useMarketplaceStore } from "../marketplace/store";

it("keeps two concurrent host install progress streams with their initiating views", async () => {
  const localResult = Promise.withResolvers<PluginInfo>();
  const marketResult = Promise.withResolvers<PluginInfo>();
  installLocal.mockReturnValue(localResult.promise);
  installMarket.mockReturnValue(marketResult.promise);
  const local = usePluginsStore.getState().installFromDirectory();
  const market = useMarketplaceStore.getState().install("market-plugin");
  await vi.waitFor(() => expect(progress.size).toBe(2));
  const localId = installLocal.mock.calls[0][1];
  const marketId = installMarket.mock.calls[0][1];
  expect(localId).not.toBe(marketId);
  for (const callback of progress) callback({ done: 10, total: 100, finished: false, requestId: localId });
  expect(usePluginsStore.getState().installing).toEqual({ done: 10, total: 100 });
  expect(useMarketplaceStore.getState().installing).toEqual({ id: "market-plugin", done: 0, total: 0 });
  for (const callback of progress) callback({ done: 90, total: 100, finished: false, requestId: marketId });
  expect(usePluginsStore.getState().installing).toEqual({ done: 10, total: 100 });
  expect(useMarketplaceStore.getState().installing).toEqual({ id: "market-plugin", done: 90, total: 100 });
  localResult.resolve({} as PluginInfo);
  marketResult.resolve({} as PluginInfo);
  await Promise.all([local, market]);
  expect(progress.size).toBe(0);
  expect(usePluginsStore.getState().installing).toBeNull();
  expect(useMarketplaceStore.getState().installing).toBeNull();
  stopPluginSync();
});
