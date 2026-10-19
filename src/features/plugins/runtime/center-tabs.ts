import { create } from "zustand";

/**
 * Plugin center-tab runtime state (SDK 0.3.12 `ui:center-tab`). Tab
 * DEFINITIONS live in the SDK centerTabRegistry (what a plugin can open);
 * this store holds the open INSTANCES (registry ids in tab order + the
 * active one), mirroring features/browser/store.ts — minus persistence:
 * plugin tabs are runtime-only, a reload starts clean.
 *
 * Ids are registry ids (`plugin:<pluginId>[:<key>]`), globally unique, so
 * one store safely holds tabs from every plugin. Stale ids (plugin
 * unloaded while its tab was open) are filtered read-side by
 * use-chat-tabs against registry membership — the store never needs to
 * listen for unloads.
 */

/** Tab strip key prefix; use-chat-tabs routes select/close/reorder by it. */
export const PLUGIN_TAB_PREFIX = "plugin-tab:";

interface PluginTabsStore {
  /** Open plugin tabs (registry ids), in tab order. */
  tabs: string[];
  /** Plugin tab shown in the center area; null = another kind is active. */
  activeId: string | null;

  /** Open (or focus) a tab and activate it. */
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  /** Activate a plugin tab (selecting one deactivates file/chat surfaces —
 *  the caller in use-chat-tabs handles that mutual exclusion). */
  activate: (id: string) => void;
  /** Clear the active plugin tab when another tab kind takes the center. */
  deactivate: () => void;
  moveTab: (id: string, toIndex: number) => void;
}

export const usePluginTabsStore = create<PluginTabsStore>()((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: (id) => {
    const s = get();
    if (s.tabs.includes(id)) {
      if (s.activeId !== id) set({ activeId: id });
      return;
    }
    set({ tabs: [...s.tabs, id], activeId: id });
  },

  closeTab: (id) => {
    const s = get();
    const idx = s.tabs.indexOf(id);
    if (idx < 0) return;
    const tabs = s.tabs.filter((t) => t !== id);
    // Neighbor fallback mirrors the browser store: same slot, else the last.
    const activeId =
      s.activeId === id ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : s.activeId;
    set({ tabs, activeId });
  },

  activate: (id) => {
    if (!get().tabs.includes(id)) return;
    set({ activeId: id });
  },

  deactivate: () => {
    if (get().activeId === null) return;
    set({ activeId: null });
  },

  moveTab: (id, toIndex) => {
    const s = get();
    const from = s.tabs.indexOf(id);
    if (from < 0) return;
    const tabs = [...s.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
    set({ tabs });
  },
}));
