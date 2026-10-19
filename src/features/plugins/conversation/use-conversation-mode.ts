import { useCallback, useReducer } from "react";
import { conversationModeRegistry, useRegistry } from "@ccgui/plugin-sdk";
import { useChatStore, sessionKey, type ActiveSession } from "@/features/chat/store";
import { getConversationModeState } from "./state";

const state = getConversationModeState();

function retainTabs() {
  state.retain(useChatStore.getState().openTabs.map((tab) => ({
    key: sessionKey(tab.engine, tab.sessionId, tab.workspacePath),
    workspacePath: tab.workspacePath,
  })));
}
if (useChatStore.getState().openTabs.length > 0) retainTabs();
const unsubscribeChat = useChatStore.subscribe((current, previous) => {
  if (current.openTabs !== previous.openTabs) retainTabs();
});
let registered = conversationModeRegistry.getSnapshot();
const unsubscribeModes = conversationModeRegistry.subscribe(() => {
  const next = conversationModeRegistry.getSnapshot();
  // Set keeps the identity check (`includes` semantics) at constant time.
  const nextSet = new Set(next);
  for (const mode of registered) {
    if (!nextSet.has(mode)) state.removeMode(mode.id);
  }
  registered = next;
});
if (import.meta.hot) import.meta.hot.dispose(() => {
  unsubscribeChat();
  unsubscribeModes();
});

export function useConversationMode(active: ActiveSession | null) {
  const modes = useRegistry(conversationModeRegistry);
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const key = active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  const identity = active ? state.identity(key, active.workspacePath, active.sessionId === null) : "";
  const onExit = useCallback(() => {
    state.exit(identity);
    rerender();
  }, [identity]);
  const onSelect = useCallback((modeId: string) => {
    const current = useChatStore.getState();
    if (!current.active || !active || current.active.workspacePath !== active.workspacePath) return;
    if (sessionKey(current.active.engine, current.active.sessionId, current.active.workspacePath) !== key) return;
    if (!conversationModeRegistry.get(modeId)) return;
    const session = current.bySession[key];
    if (state.select(identity, modeId, session?.streaming ?? false, session?.queue.length ?? 0)) rerender();
  }, [active, identity, key]);
  return { conversationId: identity, mode: modes.find((mode) => mode.id === state.selected(identity)), exitBlocked: state.isExitBlocked(identity), onExit, onSelect };
}
