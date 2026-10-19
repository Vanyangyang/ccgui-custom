import { patchSession, resolveLiveSessionKey } from "./stream";
import type { ChatStore } from "./types";
import type { StoreSet } from "./context";

/**
 * Composer and error-banner state: per-key drafts, @path mention requests,
 * and dismissing the page/session error banners.
 */

export interface ComposerDeps {
  set: StoreSet;
}

export function createComposerActions(
  deps: ComposerDeps,
): Pick<
  ChatStore,
  | "setDraft"
  | "requestMention"
  | "clearPendingMention"
  | "dismissActionError"
  | "dismissSessionError"
  | "setSessionError"
> {
  const { set } = deps;

  return {
    setDraft: (key, text) => {
      set((s) => {
        const targetKey = resolveLiveSessionKey(key, s.openTabs);
        const drafts = { ...s.drafts, [targetKey]: text };
        if (targetKey !== key && key in drafts) delete drafts[key];
        return { drafts };
      });
    },
    requestMention: (path) => {
      set((s) => ({
        pendingMention: { path, nonce: (s.pendingMention?.nonce ?? 0) + 1 },
      }));
    },

    clearPendingMention: () => {
      set({ pendingMention: null });
    },

    dismissActionError: () => {
      set({ actionError: null });
    },
    dismissSessionError: (key) => {
      patchSession(set, key, { error: null });
    },
    setSessionError: (key, message) => {
      patchSession(set, key, { error: message });
    },
  };
}
