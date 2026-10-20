import { writeStored } from "@/lib/storage";
import {
  ENGINE_PREF_KEY,
  persistTabs,
  parseDraftSessionKey,
  sameTab,
  sessionKey,
  type ActiveSession,
} from "./persistence";
import {
  adoptedDraftKeys,
  moveRetryingFlag,
  moveStreamingFlag,
} from "./stream";
import { emitSessionActivated } from "@/features/plugins/runtime/events";
import { getConversationModeState } from "@/features/plugins/conversation/state";
import type { ChatStore } from "./types";
import type { StoreGet, StoreSet } from "./context";
import { useSidechatStore } from "@/features/sidechat/store";
import { hasComposerImageDraft } from "../components/use-composer-images";

/**
 * Tab-strip actions: new/close/focus/move and the engine picker's pending-tab
 * retarget, plus the private helpers behind them (activateTab, removeTab, the
 * closed-tab reopen cache) which the other action groups reach through deps.
 */

export interface TabDeps {
  set: StoreSet;
  get: StoreGet;
}

/** Shared activation path for tab actions and lifecycle cleanup. */
export function activateChatTab({ set, get }: TabDeps, tab: ActiveSession | null) {
  if (!tab) {
    set({ active: null });
    persistTabs(get().openTabs, null);
    emitSessionActivated(null, null);
    return;
  }
  if (tab.sessionId) {
    void get().selectSession(tab.engine, tab.sessionId, tab.workspacePath);
  } else {
    adoptedDraftKeys.delete(sessionKey(tab.engine, null, tab.workspacePath));
    // A pending tab sends with its own engine, so the picker must follow it.
    const syncEngine = tab.engine !== get().activeEngine;
    if (syncEngine) writeStored(ENGINE_PREF_KEY, tab.engine);
    set(syncEngine ? { active: tab, activeEngine: tab.engine } : { active: tab });
    persistTabs(get().openTabs, tab);
    emitSessionActivated(tab.engine, null);
  }
}

/** Private tab helpers other action groups use (lifecycle closes tabs on
 * archive/delete, workspaces drop the reopen cache of a removed root). */
export interface TabHelpers {
  /** Activate a tab: existing sessions lazy-load via selectSession, pending chats just set. */
  activateTab: (tab: ActiveSession | null) => void;
  /** Stamp a per-tab composer override (model/effort) onto the active tab. */
  stampActiveTab: (patch: Partial<ActiveSession>) => void;
  /** Remove a tab; when it was active, fall back to its nearest neighbor. */
  removeTab: (
    engine: string,
    sessionId: string | null,
    workspacePath: string,
  ) => void;
  /** Drop a key from the closed-tab reopen cache (session deleted/archived). */
  forgetClosedTab: (key: string) => void;
  /** Drop reopen-cache entries for a removed workspace's dead keys. */
  forgetClosedTabs: (keys: Set<string>) => void;
}

export function createTabActions(
  deps: TabDeps,
): TabHelpers &
  Pick<
    ChatStore,
    "startNewChat" | "moveDraftToWorkspace" | "closeTab" | "focusTab" | "moveTab" | "setActiveEngine"
  > {
  const { set, get } = deps;

  /** Activate a tab: existing sessions lazy-load via selectSession, pending chats just set. */
  function activateTab(tab: ActiveSession | null) {
    activateChatTab(deps, tab);
  }

  /** Stamp a per-tab composer override (model/effort) onto the active tab, so
   * the picker follows each session across tab switches. Persists with the
   * tab list; no-op without an active tab. */
  function stampActiveTab(patch: Partial<ActiveSession>) {
    set((s) => {
      const current = s.active;
      if (!current) return {};
      const active: ActiveSession = { ...current, ...patch };
      const openTabs = s.openTabs.map((t) =>
        sameTab(t, current.engine, current.sessionId, current.workspacePath)
          ? active
          : t,
      );
      persistTabs(openTabs, active);
      return { openTabs, active };
    });
  }

  /** Reopen cache for closed tabs: keys whose bySession entry survives tab
   * close so selectSession skips a backend reload, most-recently-closed
   * last. Bounded — the oldest non-streaming entries beyond the cap are
   * evicted, so the cache cannot grow forever. */
  const CLOSED_CACHE_LIMIT = 10;
  const closedTabCache: string[] = [];

  function rememberClosedTab(key: string) {
    const i = closedTabCache.indexOf(key);
    if (i >= 0) closedTabCache.splice(i, 1);
    closedTabCache.push(key);
    // Keys whose tab is open again are not "closed" anymore.
    const openKeys = new Set(
      get().openTabs.map((t) =>
        sessionKey(t.engine, t.sessionId, t.workspacePath),
      ),
    );
    for (let j = closedTabCache.length - 1; j >= 0; j--) {
      if (openKeys.has(closedTabCache[j])) closedTabCache.splice(j, 1);
    }
    let overflow = closedTabCache.length - CLOSED_CACHE_LIMIT;
    if (overflow <= 0) return;
    const evict: string[] = [];
    for (const cached of closedTabCache) {
      if (overflow <= 0) break;
      // A streaming closed tab still receives events — never evict it.
      if (get().streamingByKey[cached]) continue;
      evict.push(cached);
      overflow--;
    }
    if (evict.length === 0) return;
    for (const cached of evict) {
      closedTabCache.splice(closedTabCache.indexOf(cached), 1);
    }
    set((s) => {
      const bySession = { ...s.bySession };
      for (const cached of evict) delete bySession[cached];
      return { bySession };
    });
  }

  /** Remove a tab; when it was active, fall back to its nearest neighbor. */
  function removeTab(
    engine: string,
    sessionId: string | null,
    workspacePath: string,
  ) {
    if (getConversationModeState().isTabCloseBlocked(sessionKey(engine, sessionId, workspacePath), workspacePath)) return;
    const s = get();
    const idx = s.openTabs.findIndex((t) =>
      sameTab(t, engine, sessionId, workspacePath),
    );
    if (idx < 0) return;
    const openTabs = s.openTabs.filter((_, i) => i !== idx);
    const key = sessionKey(engine, sessionId, workspacePath);
    useSidechatStore.getState().dismissBtw(key);
    void useSidechatStore.getState().discardSidechat(key);
    set({ openTabs, ...(sessionId === null && s.bySession[key] ? {
      bySession: { ...s.bySession, [key]: { ...s.bySession[key], draftLaunching: undefined } },
    } : {}) });
    rememberClosedTab(sessionKey(engine, sessionId, workspacePath));
    if (s.active && sameTab(s.active, engine, sessionId, workspacePath)) {
      activateTab(openTabs[Math.min(idx, openTabs.length - 1)] ?? null);
    } else {
      persistTabs(openTabs, s.active);
    }
  }

  /** Drop a key from the closed-tab reopen cache (session deleted/archived). */
  function forgetClosedTab(key: string) {
    const cacheIdx = closedTabCache.indexOf(key);
    if (cacheIdx >= 0) closedTabCache.splice(cacheIdx, 1);
  }

  /** Drop reopen-cache entries for a removed workspace's dead keys. */
  function forgetClosedTabs(keys: Set<string>) {
    for (let i = closedTabCache.length - 1; i >= 0; i--) {
      if (keys.has(closedTabCache[i])) closedTabCache.splice(i, 1);
    }
  }

  return {
    activateTab,
    stampActiveTab,
    removeTab,
    forgetClosedTab,
    forgetClosedTabs,

    startNewChat: (workspacePath) => {
      // One pending chat per workspace+engine: re-focus it instead of
      // piling up empty "new" tabs.
      set((s) => {
        const existing = s.openTabs.find(
          (t) =>
            t.sessionId === null &&
            t.engine === s.activeEngine &&
            t.workspacePath === workspacePath,
        );
        const tab: ActiveSession = existing ?? {
          engine: s.activeEngine,
          sessionId: null,
          workspacePath,
        };
        const openTabs = existing ? s.openTabs : [...s.openTabs, tab];
        persistTabs(openTabs, tab);
        const key = sessionKey(tab.engine, null, workspacePath);
        adoptedDraftKeys.delete(key);
        return { openTabs, active: tab };
      });
    },

    moveDraftToWorkspace: (engine, workspacePath, targetWorkspacePath, draft) => {
      const s = get();
      const oldKey = sessionKey(engine, null, workspacePath);
      const newKey = sessionKey(engine, null, targetWorkspacePath);
      const tab = s.openTabs.find((t) => sameTab(t, engine, null, workspacePath));
      const occupied = (key: string, path: string) => {
        const state = s.bySession[key];
        const sidechat = useSidechatStore.getState();
        return !!(s.streamingByKey[key] || s.retryingByKey[key] || state?.streaming
          || state?.loading || state?.draftLaunching || state?.messages.length
          || state?.subagentHistory.length || state?.queue.length || state?.liveLaunch
          || state?.codexRunId || state?.compaction || state?.handoff
          || sidechat.btwBySession[key] || sidechat.sidechatBySession[key]
          || hasComposerImageDraft(key)
          || getConversationModeState().hasTabMode(key, path)
          || getConversationModeState().isTabCloseBlocked(key, path));
      };
      if (!tab || occupied(oldKey, workspacePath)) return false;
      if (workspacePath === targetWorkspacePath) return true;
      const targetKeys = new Set([
        newKey, ...Object.keys(s.bySession), ...Object.keys(s.drafts),
        ...Object.keys(s.streamingByKey), ...Object.keys(s.retryingByKey),
        ...Object.keys(useSidechatStore.getState().btwBySession),
        ...Object.keys(useSidechatStore.getState().sidechatBySession),
        ...s.openTabs.map((t) => sessionKey(t.engine, t.sessionId, t.workspacePath)),
      ]);
      for (const targetKey of targetKeys) {
        if (parseDraftSessionKey(targetKey)?.workspacePath !== targetWorkspacePath) continue;
        if (s.drafts[targetKey]?.trim() || occupied(targetKey, targetWorkspacePath)) return false;
      }
      const moved = { ...tab, workspacePath: targetWorkspacePath };
      const openTabs = s.openTabs.filter((t) => !sameTab(t, engine, null, targetWorkspacePath))
        .map((t) => t === tab ? moved : t);
      const drafts = { ...s.drafts, [newKey]: draft };
      const bySession = { ...s.bySession };
      delete drafts[oldKey];
      delete bySession[newKey];
      if (bySession[oldKey]) bySession[newKey] = bySession[oldKey];
      delete bySession[oldKey];
      const active = s.active && sameTab(s.active, engine, null, workspacePath) ? moved : s.active;
      adoptedDraftKeys.delete(oldKey);
      adoptedDraftKeys.delete(newKey);
      persistTabs(openTabs, active);
      set({ openTabs, active, drafts, bySession });
      return true;
    },

    closeTab: (engine, sessionId, workspacePath) => {
      removeTab(engine, sessionId, workspacePath);
    },
    focusTab: (engine, sessionId, workspacePath) => {
      // Reuse the stored tab so its per-tab model/effort overrides apply.
      const stored = get().openTabs.find((t) =>
        sameTab(t, engine, sessionId, workspacePath),
      );
      activateTab(stored ?? { engine, sessionId, workspacePath });
    },
    moveTab: (engine, sessionId, workspacePath, toIndex) => {
      const s = get();
      const from = s.openTabs.findIndex((t) =>
        sameTab(t, engine, sessionId, workspacePath),
      );
      if (from < 0) return;
      const openTabs = [...s.openTabs];
      const [tab] = openTabs.splice(from, 1);
      openTabs.splice(Math.max(0, Math.min(toIndex, openTabs.length)), 0, tab);
      set({ openTabs });
      persistTabs(openTabs, s.active);
    },

    setActiveEngine: (engine) => {
      const current = get().active;
      if (current && getConversationModeState().isTabCloseBlocked(
        sessionKey(current.engine, current.sessionId, current.workspacePath), current.workspacePath,
      )) return;
      writeStored(ENGINE_PREF_KEY, engine);
      // Plugins follow the active engine through `session://activated`; the
      // picker is one of the ways it changes. Only the retarget below actually
      // changes what the active tab runs (a tab with a real session keeps its
      // own engine, and a first turn still in flight is left alone), so that
      // is exactly what gets announced.
      const before = get();
      const beforeActive = before.active;
      const retargets =
        !!beforeActive &&
        beforeActive.sessionId === null &&
        beforeActive.engine !== engine &&
        !before.bySession[
          sessionKey(beforeActive.engine, null, beforeActive.workspacePath)
        ]?.streaming && !before.bySession[
          sessionKey(beforeActive.engine, null, beforeActive.workspacePath)
        ]?.draftLaunching;
      set((s) => {
        const active = s.active;
        // A pending (never-sent) tab has no backend session yet, so it
        // follows the picker: retarget it to the newly selected engine.
        // Otherwise the chip shows the new CLI while sends still go to the
        // engine the tab was created with.
        if (!active || active.sessionId !== null || active.engine === engine) {
          return { activeEngine: engine };
        }
        const oldKey = sessionKey(active.engine, null, active.workspacePath);
        // First turn still in flight (native id not yet assigned): event
        // routing is keyed to the old engine, so leave the tab untouched.
        if (s.bySession[oldKey]?.streaming || s.bySession[oldKey]?.draftLaunching) return { activeEngine: engine };
        const newKey = sessionKey(engine, null, active.workspacePath);
        adoptedDraftKeys.delete(oldKey);
        adoptedDraftKeys.delete(newKey);
        const existing = s.openTabs.find(
          (t) =>
            !sameTab(
              t,
              active.engine,
              active.sessionId,
              active.workspacePath,
            ) &&
            t.sessionId === null &&
            t.engine === engine &&
            t.workspacePath === active.workspacePath,
        );
        // Carry unsent drafts / session state over to the new key.
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        if (bySession[oldKey] && !bySession[newKey])
          bySession[newKey] = { ...bySession[oldKey], claudeUltracode: undefined };
        delete bySession[oldKey];
        if (drafts[oldKey] !== undefined) {
          if (!drafts[newKey]?.trim()) {
            drafts[newKey] = drafts[oldKey];
          } else if (drafts[oldKey].trim() && drafts[newKey] !== drafts[oldKey]) {
            drafts[newKey] = `${drafts[newKey].trim()}\n\n${drafts[oldKey]}`;
          }
        }
        delete drafts[oldKey];
        let openTabs: ActiveSession[];
        let nextActive: ActiveSession;
        if (existing) {
          // A pending tab for this engine+workspace already exists: fold
          // into it instead of stacking a duplicate.
          openTabs = s.openTabs.filter(
            (t) =>
              !sameTab(
                t,
                active.engine,
                active.sessionId,
                active.workspacePath,
              ),
          );
          nextActive = existing;
        } else {
          // Engine retarget: the old engine's model/effort overrides don't
          // apply to the new one — drop them so defaults resolve fresh.
          nextActive = {
            ...active,
            engine,
            model: undefined,
            effort: undefined,
            claudeUltracode: undefined,
            claudeHaikuAssist: undefined,
            provider: undefined,
          };
          openTabs = s.openTabs.map((t) =>
            sameTab(t, active.engine, active.sessionId, active.workspacePath)
              ? nextActive
              : t,
          );
        }
        persistTabs(openTabs, nextActive);
        return {
          activeEngine: engine,
          openTabs,
          active: nextActive,
          bySession,
          drafts,
          streamingByKey: moveStreamingFlag(s.streamingByKey, oldKey, newKey),
          retryingByKey: moveRetryingFlag(s.retryingByKey, oldKey, newKey),
        };
      });
      if (retargets) emitSessionActivated(engine, null);
    },
  };
}
