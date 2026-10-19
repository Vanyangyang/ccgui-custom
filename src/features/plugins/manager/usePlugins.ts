import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { ipc, type PluginInfo } from "@/lib/ipc";
import { listenPluginInstallProgress } from "@/lib/events";
import { pickDirectory } from "@/lib/platform";
import { invoke, listen, isWeb } from "@/lib/transport";
import {
  bootstrapPlugins,
  getPluginStatesSnapshot,
  ipcBackend,
  pluginsBootstrapped,
  synchronizePlugins,
  subscribePluginStates,
} from "../runtime/loader";
import i18n from "@/lib/i18n";
import { BUILTIN_PLUGINS } from "../builtin";
import { useMarketplaceStore } from "../marketplace/store";
import { createPluginInstallRequestId } from "./install-request";

/** Live runtime states (loading/active/failed/quarantined/…) for the manager UI. */
export function usePluginStates() {
  return useSyncExternalStore(subscribePluginStates, getPluginStatesSnapshot);
}

interface PluginsStore {
  installed: PluginInfo[];
  loaded: boolean;
  error: string | null;
  /** Non-null while an install copy runs; done/total are bytes (total 0 = measuring). */
  installing: { done: number; total: number } | null;
  refresh: () => Promise<void>;
  installFromDirectory: () => Promise<void>;
  setEnabled: (plugin: PluginInfo, enabled: boolean) => Promise<void>;
  /** Clear a quarantine/failure and load the plugin again, in place. */
  retry: (plugin: PluginInfo) => Promise<void>;
  uninstall: (plugin: PluginInfo, deleteData: boolean) => Promise<void>;
}

/** Builtin metadata merged into the manager list: a builtin's state record
 *  (created by enable/quarantine upserts) carries no manifest fields, so the
 *  builtin's own info wins the display fields while the record wins state
 *  (enabled/quarantined/lastError). One row per id. */
function withBuiltins(installed: PluginInfo[]): PluginInfo[] {
  const builtinById: Record<string, PluginInfo> = {};
  for (const b of BUILTIN_PLUGINS) builtinById[b.info.id] = b.info;
  const seen: Record<string, true> = {};
  const merged = installed.flatMap((record) => {
    const builtin = builtinById[record.id];
    // State-only leftovers of a since-removed builtin (no directory, no
    // manifest fields) must not surface as ghost rows.
    if (!builtin && record.source === "builtin" && record.version === "") return [];
    if (!builtin) return [record];
    seen[record.id] = true;
    return {
      ...builtin,
      enabled: record.enabled,
      quarantined: record.quarantined,
      lastError: record.lastError,
      installedAt: record.installedAt,
    };
  });
  for (const builtin of BUILTIN_PLUGINS) {
    if (!seen[builtin.info.id]) merged.push(builtin.info);
  }
  return merged;
}

interface PluginsChanged { id: string | null; reload: boolean }
let listenersReady: Promise<void> | null = null;
let refreshInFlight: Promise<void> | null = null;
let pendingRefresh = false;
let reloadAll = false;
const reloadIds = new Set<string>();
let syncGeneration = 0;
let syncUnlisteners: (() => void)[] = [];

export function stopPluginSync(): void {
  syncGeneration += 1;
  for (const unlisten of syncUnlisteners.splice(0)) unlisten();
  listenersReady = null;
  refreshInFlight = null;
  pendingRefresh = false;
  reloadIds.clear();
  reloadAll = false;
}

if (import.meta.hot) import.meta.hot.dispose(stopPluginSync);

/** One process-wide consumer per frontend, independent of mounted hub views. */
export function ensurePluginSync(): Promise<void> {
  const generation = syncGeneration;
  listenersReady ??= (async () => {
    const unlisteners: (() => void)[] = [];
    try {
      unlisteners.push(await listen<PluginsChanged>("plugins://changed", ({ payload }) => {
        if (generation !== syncGeneration) return;
        if (payload?.reload) {
          if (payload.id) reloadIds.add(payload.id);
          else reloadAll = true;
        }
        void refreshSnapshot(false);
        void useMarketplaceStore.getState().checkUpdates();
      }));
      if (isWeb) unlisteners.push(await listen("transport://connected", () => {
        if (generation !== syncGeneration) return;
        // Handshake events can follow a disconnected install of the same version.
        reloadAll ||= pluginsBootstrapped();
        void refreshSnapshot(false);
        void useMarketplaceStore.getState().checkUpdates();
      }));
      if (generation !== syncGeneration) {
        for (const unlisten of unlisteners) unlisten();
      } else syncUnlisteners = unlisteners;
    } catch (error) {
      for (const unlisten of unlisteners) unlisten();
      throw error;
    }
  })().catch((error) => {
    if (generation === syncGeneration) listenersReady = null;
    throw error;
  });
  return listenersReady;
}

async function refreshSnapshot(clearError: boolean): Promise<void> {
  if (clearError) usePluginsStore.setState({ error: null });
  pendingRefresh = true;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const generation = syncGeneration;
    try {
      await ensurePluginSync();
      if (generation !== syncGeneration) return;
      if (!pluginsBootstrapped()) await bootstrapPlugins(ipcBackend, BUILTIN_PLUGINS);
      if (generation !== syncGeneration) return;
      while (pendingRefresh && generation === syncGeneration) {
        pendingRefresh = false;
        const forceIds = new Set(reloadIds);
        const forceAll = reloadAll;
        reloadIds.clear();
        reloadAll = false;
        try {
          const installed = await ipc.pluginList();
          if (generation !== syncGeneration) return;
          if (pendingRefresh) {
            // A newer invalidation arrived while this snapshot was read. Carry
            // reload hints forward and never activate the superseded state.
            for (const id of forceIds) reloadIds.add(id);
            reloadAll ||= forceAll;
            continue;
          }
          await synchronizePlugins(installed, BUILTIN_PLUGINS, forceIds, forceAll);
          if (generation !== syncGeneration) return;
          usePluginsStore.setState({ installed: withBuiltins(installed), loaded: true });
        } catch (error) {
          if (generation !== syncGeneration) return;
          for (const id of forceIds) reloadIds.add(id);
          reloadAll ||= forceAll;
          throw error;
        }
      }
    } catch (error) {
      if (generation !== syncGeneration) return;
      usePluginsStore.setState({ error: String(error), loaded: true });
    } finally { if (generation === syncGeneration) refreshInFlight = null; }
  })();
  return refreshInFlight;
}

export const usePluginsStore = create<PluginsStore>((set, get) => ({
  installed: [],
  loaded: false,
  error: null,
  installing: null,

  refresh: () => refreshSnapshot(true),

  installFromDirectory: async () => {
    if (get().installing) return;
    const path = await pickDirectory(i18n.t(isWeb ? "plugins.installHostPathTitle" : "plugins.installPickTitle"));
    if (!path) return;
    set({ installing: { done: 0, total: 0 }, error: null });
    const requestId = createPluginInstallRequestId();
    let unlisten: (() => void) | undefined;
    try {
      await ensurePluginSync();
      unlisten = await listenPluginInstallProgress((p) => {
        if (p.requestId !== requestId) return;
        set({ installing: { done: p.done, total: p.total } });
      });
      await ipc.pluginInstallFromPath(path, requestId);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      unlisten?.();
      set({ installing: null });
    }
  },

  setEnabled: async (plugin, enabled) => {
    set({ error: null });
    try {
      await ensurePluginSync();
      await ipc.pluginSetEnabled(plugin.id, enabled);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  retry: async (plugin) => {
    set({ error: null });
    try {
      await ensurePluginSync();
      await invoke<PluginInfo>("plugin_reload", { id: plugin.id });
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  uninstall: async (plugin, deleteData) => {
    set({ error: null });
    try {
      await ensurePluginSync();
      await ipc.pluginUninstall(plugin.id, deleteData);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },
}));
