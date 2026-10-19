import { create } from "zustand";
import { readStoredJson, writeStored } from "@/lib/storage";
import { closeBrowserWebview } from "./webview";

/** Persisted browser tabs (order + active), same convention as chat's
 * OPEN_TABS_KEY. Webview handles are runtime-only — they are recreated
 * lazily when a restored tab first becomes active. */
export const BROWSER_TABS_KEY = "ccgui-next.browserTabs:v1";

/** Tab strip key prefix; use-chat-tabs routes select/close/reorder by it. */
export const BROWSER_TAB_PREFIX = "browser:";

export interface BrowserTab {
  /** Safe-alphabet id; the native webview label is "browser-<id>". */
  id: string;
  url: string;
  /** Last document title; empty until the page reports one. */
  title: string;
}

interface BrowserStore {
  /** Open browser tabs, in tab order. */
  tabs: BrowserTab[];
  /** Browser tab shown in the center area; null = another kind is active. */
  activeId: string | null;

  /** Open a new browser tab and activate it. Returns the new tab id. */
  openTab: (url?: string) => string;
  closeTab: (id: string) => void;
  /** Activate a browser tab (selecting one deactivates file/chat surfaces). */
  activate: (id: string) => void;
  /** Clear the active browser tab when another tab kind takes the center. */
  deactivate: () => void;
  moveTab: (id: string, toIndex: number) => void;
  setUrl: (id: string, url: string) => void;
  setTitle: (id: string, title: string) => void;
}

const DEFAULT_URL = "https://www.google.com";

function newTabId(): string {
  // Hex-only alphabet keeps the native webview label collision-safe.
  return `b${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
}

function isBrowserTab(value: unknown): value is BrowserTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    typeof tab.url === "string" &&
    typeof tab.title === "string"
  );
}

interface PersistedBrowserTabs {
  tabs: BrowserTab[];
  activeId: string | null;
}

function readPersisted(): PersistedBrowserTabs {
  return (
    readStoredJson(BROWSER_TABS_KEY, (value): PersistedBrowserTabs | null => {
      if (typeof value !== "object" || value === null) return null;
      const v = value as Record<string, unknown>;
      if (!Array.isArray(v.tabs) || !v.tabs.every(isBrowserTab)) return null;
      const tabs = v.tabs as BrowserTab[];
      const activeId =
        typeof v.activeId === "string" && tabs.some((t) => t.id === v.activeId)
          ? v.activeId
          : null;
      return { tabs, activeId };
    }) ?? { tabs: [], activeId: null }
  );
}

function persist(tabs: BrowserTab[], activeId: string | null) {
  writeStored(BROWSER_TABS_KEY, JSON.stringify({ tabs, activeId }));
}

export const useBrowserStore = create<BrowserStore>()((set, get) => ({
  ...readPersisted(),

  openTab: (url) => {
    const tab: BrowserTab = { id: newTabId(), url: url ?? DEFAULT_URL, title: "" };
    const tabs = [...get().tabs, tab];
    set({ tabs, activeId: tab.id });
    persist(tabs, tab.id);
    return tab.id;
  },

  closeTab: (id) => {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tabs = s.tabs.filter((t) => t.id !== id);
    // Neighbor fallback mirrors chat's removeTab: same slot, else the last.
    const activeId =
      s.activeId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeId;
    set({ tabs, activeId });
    persist(tabs, activeId);
    // Native side is idempotent and no-ops on web/unknown ids.
    void closeBrowserWebview(id);
  },

  activate: (id) => {
    if (!get().tabs.some((t) => t.id === id)) return;
    set({ activeId: id });
    persist(get().tabs, id);
  },

  deactivate: () => {
    if (get().activeId === null) return;
    set({ activeId: null });
    persist(get().tabs, null);
  },

  moveTab: (id, toIndex) => {
    const s = get();
    const from = s.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const tabs = [...s.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
    set({ tabs });
    persist(tabs, s.activeId);
  },

  setUrl: (id, url) => {
    const tabs = get().tabs.map((t) => (t.id === id ? { ...t, url } : t));
    set({ tabs });
    persist(tabs, get().activeId);
  },

  setTitle: (id, title) => {
    // Title events can repeat the same value during load; skip no-ops.
    const current = get().tabs.find((t) => t.id === id);
    if (!current || current.title === title) return;
    const tabs = get().tabs.map((t) => (t.id === id ? { ...t, title } : t));
    set({ tabs });
    persist(tabs, get().activeId);
  },
}));

/** Reset hook for tests. */
export function resetBrowserStoreForTests() {
  useBrowserStore.setState({ tabs: [], activeId: null });
}
