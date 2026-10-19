import { create } from "zustand";

/**
 * Native plugin hub: the center-strip page behind the sidebar's 插件 entry.
 * Open/active follow the mission workbench pattern (single-instance native
 * tab, state kept across tab switches); `view` lets the palette commands
 * land directly on 市场 or 已安装.
 */

export const PLUGIN_HUB_TAB_KEY = "plugin-hub:main";

export type PluginHubView = "market" | "installed";

interface PluginHubState {
  /** The center tab exists (page stays mounted, visibility follows `active`). */
  open: boolean;
  /** The hub is the center pane currently in view. */
  active: boolean;
  /** 市场 / 已安装 tab inside the page. */
  view: PluginHubView;
  /** Sidebar entry + palette commands: open (or focus) the hub. */
  openHub: (view?: PluginHubView) => void;
  activate: () => void;
  deactivate: () => void;
  close: () => void;
  setView: (view: PluginHubView) => void;
}

export const usePluginHubStore = create<PluginHubState>()((set, get) => ({
  open: false,
  active: false,
  view: "market",

  // No view argument = keep whatever tab the user left open; a palette
  // command naming a tab switches to it.
  openHub: (view) => set({ open: true, active: true, ...(view ? { view } : {}) }),
  activate: () => set({ active: true }),
  deactivate: () => {
    if (!get().active) return;
    set({ active: false });
  },
  close: () => set({ open: false, active: false }),
  setView: (view) => set({ view }),
}));
