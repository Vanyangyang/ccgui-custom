import { ipc } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";
import {
  PERMISSION_PREF_KEY,
  persistTabs,
  sessionKey,
  type ActiveSession,
} from "./persistence";
import { patchSession, resolveLiveSessionTab } from "./stream";
import { notifyCliConfigChanged } from "@/features/settings/providers";
import { persistSettings } from "./settings-persist";
import { persistClaudeUltracode } from "./claude-ultracode";
import { normalizeEffortLevel } from "@/components/application/ai-chat/effort-levels";
import { encodedModelEffort } from "@/components/application/ai-chat/model-effort";
import type { ChatStore } from "./types";
import type { StoreGet, StoreSet } from "./context";

/**
 * Preference actions: composer permission, service tiers, per-engine
 * model/effort/provider picks, and the small settings-backed toggles
 * (thread limit, send shortcut, thinking auto-collapse).
 */

export interface PreferenceDeps {
  set: StoreSet;
  get: StoreGet;
  stampActiveTab: (patch: Partial<ActiveSession>) => void;
}

export function createPreferenceActions(
  deps: PreferenceDeps,
): Pick<
  ChatStore,
  | "setPermission"
  | "setOmpServiceTier"
  | "setCodexServiceTier"
  | "setEffort"
  | "setClaudeUltracode"
  | "setClaudeHaikuAssist"
  | "setModel"
  | "setProvider"
  | "pinModels"
  | "setThreadLimit"
  | "setSendShortcut"
  | "setThinkingAutoCollapse"
> {
  const { set, get, stampActiveTab } = deps;

  return {
    setPermission: (permission) => {
      writeStored(PERMISSION_PREF_KEY, permission);
      set({ permission });
    },
    setOmpServiceTier: async (tier) => {
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, ompOpenaiServiceTier: tier });
      set({ ompServiceTier: tier });
    },
    setCodexServiceTier: async (tier) => {
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, codexServiceTier: tier });
      set({ codexServiceTier: tier });
    },
    setEffort: async (engine, effort) => {
      effort = normalizeEffortLevel(engine, effort);
      const active = resolveLiveSessionTab(get().active, get().openTabs);
      if (active?.engine === engine && active.sessionId) {
        const key = sessionKey(engine, active.sessionId, active.workspacePath);
        patchSession(set, key, { activeEffort: effort });
        set((s) => ({
          sessions: s.sessions.map((session) =>
            session.engine === engine && session.sessionId === active.sessionId
              ? { ...session, effort }
              : session,
          ),
        }));
        void ipc.rememberSessionEffort(engine, active.sessionId, effort).catch(() => {});
        return;
      }
      set({ efforts: { ...get().efforts, [engine]: effort } });
      if (active?.engine === engine) stampActiveTab({ effort });
      await persistSettings((settings) => ({
        defaultEfforts: { ...settings.defaultEfforts, [engine]: effort },
      }));
    },
    setClaudeUltracode: async (enabled) => {
      const active = resolveLiveSessionTab(get().active, get().openTabs);
      if (active?.engine === "claude" && active.sessionId) {
        patchSession(set, sessionKey("claude", active.sessionId, active.workspacePath), { claudeUltracode: enabled });
        stampActiveTab({ claudeUltracode: undefined });
        await persistClaudeUltracode(set, enabled, active.sessionId);
      } else {
        set({ defaultClaudeUltracode: enabled });
        if (active?.engine === "claude") {
          stampActiveTab({ claudeUltracode: enabled });
          // A native id can arrive after the user changes a starting pick.
          patchSession(set, sessionKey("claude", null, active.workspacePath), { claudeUltracode: enabled });
        }
        await persistClaudeUltracode(set, enabled);
      }
    },
    setClaudeHaikuAssist: (enabled, target = get().active ?? undefined) => {
      if (target?.engine !== "claude") return;
      const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
      set((s) => {
        const matches = (tab: ActiveSession) => sessionKey(tab.engine, tab.sessionId, tab.workspacePath) === key;
        if (!s.openTabs.some(matches)) return {};
        const openTabs = s.openTabs.map((tab) => matches(tab) ? { ...tab, claudeHaikuAssist: enabled } : tab);
        const active = s.active && matches(s.active) ? { ...s.active, claudeHaikuAssist: enabled } : s.active;
        persistTabs(openTabs, active);
        return { openTabs, active };
      });
    },
    setModel: async (engine, model) => {
      const active = resolveLiveSessionTab(get().active, get().openTabs);
      // Model choice is a property of the CONVERSATION: picking one inside a
      // session must not rewrite the engine-wide default, or a second session
      // of the same CLI would silently switch models with it. Only a pending
      // "new chat" tab (no session yet) edits the default — that tab is where
      // the next conversation's starting choice is made.
      if (!active || active.sessionId === null || active.engine !== engine) {
        const models = { ...get().models };
        if (model) models[engine] = model;
        else delete models[engine];
        set({ models });
        await persistSettings((settings) => {
          const defaultModels = { ...settings.defaultModels };
          if (model) defaultModels[engine] = model;
          else delete defaultModels[engine];
          return { defaultModels };
        });
      }
      if (active?.engine === engine) {
        // Empty = "CLI default": clear the tab override so the session falls
        // back to its own history/model default again.
        stampActiveTab({ model: model || undefined });
        if (active.sessionId && model) {
          const key = sessionKey(engine, active.sessionId, active.workspacePath);
          if (encodedModelEffort(engine, model) && get().bySession[key]?.activeEffort) {
            patchSession(set, key, { activeEffort: null });
          }
          // Remember the chosen model on the session immediately so switching
          // between an encoded-tier catalog model (e.g. gemini-4-argon-high) and
          // an independent-effort model (e.g. gemini-4-argon) keeps session_models
          // in sync with remember_session_effort before the next send.
          patchSession(set, key, { activeModel: model });
          set((s) => ({ sessions: s.sessions.map((session) => session.engine === engine && session.sessionId === active.sessionId
            ? { ...session, model, ...(encodedModelEffort(engine, model) ? { effort: null } : {}) } : session) }));
          await ipc.rememberSessionModel(engine, active.sessionId, model);
        }
      }
    },
    setProvider: async (engine, providerId) => {
      const active = get().active;
      try {
        if (active?.engine === engine && active.sessionId) {
          await ipc.rememberSessionProvider(engine, active.sessionId, providerId);
          const key = sessionKey(engine, active.sessionId, active.workspacePath);
          patchSession(set, key, { activeProvider: providerId });
          if (get().active === active) stampActiveTab({ provider: undefined });
        } else {
          await ipc.setCurrentProvider(engine, providerId);
          set({ providers: { ...get().providers, [engine]: providerId } });
          if (get().active === active && active?.engine === engine) {
            stampActiveTab({ provider: providerId || undefined });
          }
          notifyCliConfigChanged();
        }
        set({ actionError: null });
      } catch (error) {
        // Migration conflicts and failed writes must not leave a checkmark
        // on a channel the backend never accepted.
        set({ actionError: errorText(error) });
      }
    },
    pinModels: async (updates, persist = true) => {
      const entries = Object.entries(updates).filter(([, model]) =>
        model.trim(),
      );
      if (entries.length === 0) return;
      const models = { ...get().models };
      for (const [engine, model] of entries) models[engine] = model;
      set({ models });
      if (!persist) return;
      await persistSettings((settings) => ({
        defaultModels: {
          ...settings.defaultModels,
          ...Object.fromEntries(entries),
        },
      }));
    },

    setThreadLimit: (limit) => {
      set({ threadLimit: Math.max(1, Math.floor(limit)) });
    },

    setSendShortcut: (shortcut) => {
      set({ sendShortcut: shortcut });
    },
    setThinkingAutoCollapse: (autoCollapse) => {
      set({ thinkingAutoCollapse: autoCollapse });
    },
  };
}
