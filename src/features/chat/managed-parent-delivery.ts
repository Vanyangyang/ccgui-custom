import type { HostChatTarget } from "@ccgui/plugin-sdk";
import { invoke } from "@/lib/transport";
import { useChatStore, sessionKey } from "./store";
import { HostChatBusyError, type ChatStore } from "./store/types";
import { codexSteerBlocker, hasOpenCard, liveFollowUpBlocker } from "./store/live-follow-up";
import { resolveSessionModel, resolveSessionEffort, resolveSessionProvider } from "./store/stream";
import { parentWorkspacePath, type LeaderSnapshot } from "@/features/leader/types";
import { sameParticipant } from "@/features/plugins/runtime/chat-inbox";
import type { ManagedParentDeliveryFacade } from "@/features/plugins/runtime/chat-bridge";
import { TaskPreSpawnError } from "@/features/plugins/runtime/task-facade";

type Dependencies = {
  store: { getState(): ChatStore };
  snapshot(): Promise<LeaderSnapshot>;
};

/** Host-only adapter. The native event grants no general permission: recheck
 * its exact durable relationship and the parent's current launch before IPC. */
export function createManagedParentDelivery(beforeIdleSend: (target: HostChatTarget) => Promise<void>, deps: Dependencies = {
  store: useChatStore,
  snapshot: () => invoke<LeaderSnapshot>("task_snapshot", {}),
}): ManagedParentDeliveryFacade {
  const ref = (target: HostChatTarget) => ({ engine: target.engine, sessionId: target.nativeSessionId, workspacePath: target.workspacePath });
  const tabOf = (state: ChatStore, target: HostChatTarget) => state.openTabs.find(tab =>
    tab.engine === target.engine && tab.sessionId === target.nativeSessionId && tab.workspacePath === target.workspacePath);
  const choices = (state: ChatStore, target: HostChatTarget) => {
    const tab = tabOf(state, target);
    if (!tab) throw new TaskPreSpawnError("Exact parent conversation is unavailable");
    const session = state.bySession[sessionKey(tab.engine, tab.sessionId, tab.workspacePath)];
    const model = resolveSessionModel(tab, session, state.models[tab.engine]);
    const effort = resolveSessionEffort(tab, session, state.efforts[tab.engine], state.models[tab.engine]);
    const providerId = resolveSessionProvider(tab, session, state.providers?.[tab.engine]);
    return { model, effort, providerId, permission: state.permission };
  };
  const inspect: ManagedParentDeliveryFacade["inspect"] = target => {
    const state = deps.store.getState(), tab = tabOf(state, target), exact = ref(target);
    const key = sessionKey(target.engine, target.nativeSessionId, target.workspacePath), session = state.bySession[key];
    if (!state.initialized || !tab || !session || session.loading || state.archivedSessionKeys[key] ||
      [...state.openTabs, ...state.sessions].some(candidate => candidate.engine === target.engine && candidate.sessionId === target.nativeSessionId && !sameParticipant(candidate as typeof exact, exact))) return null;
    const runId = target.engine === "codex" ? session.codexRunId ?? null : session.nativeTaskRunId ?? null;
    const awaiting = hasOpenCard(session);
    const stopped = session.interrupted || session.queueParked || Boolean(session.draftLaunching);
    const supported = !session.streaming || !codexSteerBlocker(state, tab, session) || !liveFollowUpBlocker(state, tab, session);
    return { status: awaiting ? "awaiting_permission" : session.streaming ? "busy" : "idle", runId,
      canDeliver: !stopped && !awaiting && supported };
  };
  return {
    inspect,
    async validate(target, parent, sender) {
      if (!sameParticipant(ref(target), parent)) return false;
      let snapshot: LeaderSnapshot;
      try { snapshot = await deps.snapshot(); }
      catch { throw new TaskPreSpawnError("Native task relationship is temporarily unavailable"); }
      const children = snapshot.branches.filter(branch => branch.sessionId &&
        sameParticipant({ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath }, sender));
      if (children.length !== 1) return false;
      const branch = children[0];
      return branch.id === parent.branchId && !["reclaimed", "handed_off"].includes(String(branch.state)) &&
        sameParticipant({ engine: branch.parentEngine, sessionId: branch.parentSessionId, workspacePath: parentWorkspacePath(branch) }, parent) &&
        !snapshot.archivedGroups?.some(group => group.branchIds.includes(branch.id) ||
          group.members.some(member => sameParticipant(member, sender) || sameParticipant(member, parent)));
    },
    async deliver(target, prompt, requestedRunId, beforeDelivery) {
      const initial = inspect(target);
      if (!initial?.canDeliver) throw new TaskPreSpawnError("Parent is not at a safe input boundary");
      const frozen = choices(deps.store.getState(), target);
      let received: { delivery: "turn" | "steer" | "live"; runId: string } | undefined;
      const unchanged = () => JSON.stringify(choices(deps.store.getState(), target)) === JSON.stringify(frozen);
      const state = deps.store.getState(), tab = tabOf(state, target)!;
      const launch = {
        ...(frozen.model !== undefined ? { model: frozen.model } : {}),
        ...(frozen.effort !== undefined ? { effort: frozen.effort } : {}),
        ...(frozen.providerId !== undefined ? { providerId: frozen.providerId } : {}),
        defaultModel: state.models[tab.engine] || null,
        defaultEffort: state.efforts[tab.engine] ?? null,
        defaultProvider: state.providers?.[tab.engine] ?? null,
      };
      try {
        await state.sendWhileBusy(prompt, [], {
          requestedRunId, hostLaunch: launch,
          onRunStarted(result) {
            if (result.runId !== requestedRunId || (result.sessionId !== null && result.sessionId !== target.nativeSessionId)) throw new Error("Parent native acknowledgement changed identity");
          },
          hostContinuation: {
            priority: true,
            async beforeDelivery(delivery, runId) {
              if (delivery === "turn") {
                try { await beforeIdleSend(target); }
                catch (error) { throw new TaskPreSpawnError(error instanceof Error ? error.message : "Native parent retirement could not be verified"); }
              }
              const admissible = () => {
                const current = inspect(target);
                return current?.canDeliver && unchanged() && (delivery === "turn"
                  ? current.status === "idle" && runId === requestedRunId
                  : current.runId === runId && current.runId === initial.runId);
              };
              if (!admissible()) throw new HostChatBusyError("Exact parent changed before input");
              await beforeDelivery(delivery, runId);
              if (!admissible()) throw new HostChatBusyError("Exact parent changed during input preparation");
            },
            onReceived(delivery, runId) { received = { delivery, runId }; },
          },
        }, tab);
      } catch (error) {
        if (error instanceof HostChatBusyError) throw new TaskPreSpawnError(error.message);
        throw error;
      }
      if (!received) throw new Error("Parent input outcome is uncertain; no automatic retry");
      return received;
    },
  };
}
