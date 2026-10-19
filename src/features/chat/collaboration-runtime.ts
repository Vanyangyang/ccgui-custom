import { listen } from "@/lib/transport";
import { ipc } from "@/lib/ipc";
import { useChatStore, sessionKey } from "./store";
import { applyPlanReview } from "./store/plan-review";
import { invalidateSlashCommandCatalog } from "@/components/application/ai-chat/slash-commands";
import { notifyCliConfigChanged } from "@/features/settings/providers";

/** Host invalidations are shared by the desktop and every connected browser. */
export function startCollaborationRuntime() {
  let disposed = false;
  let revision = 0;
  const pending = new Map<string, number>();
  const offs: Array<() => void> = [];
  const refreshPlan = async (engine: string, sessionId: string) => {
    const key = sessionKey(engine, sessionId, "");
    if (!useChatStore.getState().bySession[key]) return;
    const ticket = ++revision;
    pending.set(key, ticket);
    try {
      const records = await ipc.listPlanReviews(engine, sessionId);
      if (disposed || pending.get(key) !== ticket) return;
      useChatStore.setState((state) => {
        const current = state.bySession[key];
        if (!current) return state;
        let messages = current.messages;
        for (const record of [...records].sort((a, b) => a.revision - b.revision)) {
          messages = applyPlanReview(messages, record) ?? messages;
        }
        return messages === current.messages ? state : {
          bySession: { ...state.bySession, [key]: { ...current, messages } },
        };
      });
    } catch {
      // Keep the last confirmed cards on connection failure; existing card
      // actions still report failures, and reconnect retries this snapshot.
    } finally {
      if (pending.get(key) === ticket) pending.delete(key);
    }
  };
  const reconnect = () => {
    if (disposed) return;
    invalidateSlashCommandCatalog();
    notifyCliConfigChanged();
    void useChatStore.getState().refreshWorkspaces();
    void useChatStore.getState().refreshSessions();
    for (const tab of useChatStore.getState().openTabs) {
      if (tab.sessionId) void refreshPlan(tab.engine, tab.sessionId);
    }
  };
  const subscribe = (name: string, cb: (event: { payload: unknown }) => void) => {
    void listen(name, (event) => { if (!disposed) cb(event); }).then((off) => {
      if (disposed) off(); else offs.push(off);
    }).catch(() => { /* A failed Web connection will retry on reconnect. */ });
  };
  subscribe("plan-review://changed", ({ payload }) => {
    const identity = payload as { engine?: unknown; sessionId?: unknown } | null;
    if (typeof identity?.engine === "string" && typeof identity.sessionId === "string") {
      void refreshPlan(identity.engine, identity.sessionId);
    }
  });
  subscribe("sessions://changed", () => { void useChatStore.getState().refreshWorkspaces(); });
  subscribe("skills://changed", invalidateSlashCommandCatalog);
  subscribe("engine-config://changed", notifyCliConfigChanged);
  subscribe("transport://connected", reconnect);
  return () => { disposed = true; pending.clear(); offs.forEach((off) => off()); };
}
