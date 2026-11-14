import { invoke, isWeb } from "@/lib/transport";
import { newId } from "@/lib/id";
import i18n from "@/lib/i18n";
import { runtimeCheckpoint } from "@/lib/runtime-checkpoint";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { useSessionSendCostGuardStore } from "@/features/chat/cross-session-cost";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { desktopTaskFacade, TaskPreSpawnError, type HostTaskFacade, type TaskSessionRef } from "@/features/plugins/runtime/task-facade";
import { sameLeaderWorkspace } from "./workspace-path";
import { useLeaderStore } from "./store";

/** Native-owned completion identity. No child report is copied into this queue. */
export interface ParentWakeup {
  id: string;
  branchId: string;
  parent: TaskSessionRef;
  requestId: string;
  childRunId: string;
  state: "pending" | "starting" | "delivered" | "consumed" | "unknown" | "cancelled";
  runId?: string | null;
}
type Outcome = "delivered" | "retry" | "unknown" | "cancelled";
type WakeHost = Pick<HostTaskFacade, "ready" | "known" | "inspect" | "idleForContinuation" | "openBackground" | "continueMessage" | "wasInterrupted">;
interface Dependencies {
  host(): Promise<WakeHost>;
  list(): Promise<ParentWakeup[]>;
  claim(id: string, runId: string): Promise<boolean>;
  resolve(id: string, runId: string, outcome: Outcome): Promise<boolean>;
  blocked(parent: TaskSessionRef): "stopped" | "held" | false;
  target?(parent: TaskSessionRef): TaskSessionRef;
  paused(): boolean;
  runId(): string;
  prompt(notice: ParentWakeup): string;
  error(): void;
}

class AlreadyConsumed extends TaskPreSpawnError {}

/** The native outbox is durable; this owner only schedules exact, idle timelines.
 * A lost native ACK leaves a starting/unknown receipt, never another send. */
export function createParentWakeupRuntime(deps: Dependencies) {
  let disposed = false;
  let pending = new Map<string, ParentWakeup>();
  const deferred = new Set<string>();
  const activeStarts = new Set<string>();
  const reportedUnknown = new Set<string>();
  let draining: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;
  let wakeAgain = false;
  let starts = 0;
  const allowed = (parent: TaskSessionRef) => {
    if (disposed || deps.paused() || deps.blocked(parent)) throw new TaskPreSpawnError("Parent continuation is held");
  };
  const idle = (host: WakeHost, parent: TaskSessionRef) => host.idleForContinuation?.(parent) ?? host.inspect(parent) === "idle";

  async function deliver(host: WakeHost, notice: ParentWakeup, parent: TaskSessionRef) {
    let claimedRun: string | undefined;
    let declined = false;
    const runId = deps.runId();
    starts++;
    activeStarts.add(notice.id);
    try {
      const beforeNative = async () => {
        allowed(parent);
        if (!host.known(parent) || host.inspect(parent) === null || host.inspect(parent) === "awaiting_permission") {
          throw new TaskPreSpawnError("Parent is awaiting permission or unavailable");
        }
      };
      const ack = await host.continueMessage!(parent, deps.prompt(notice), [], runId,
        async (delivery, actualRunId) => {
          allowed(parent);
          if (delivery === "steer" || !idle(host, parent)) throw new TaskPreSpawnError("Parent is busy");
          claimedRun = actualRunId;
          // A persistent CLI reuses its native run id. The distinct delivery
          // reservation also fences a replacement StrictMode/runtime owner.
          if (!await deps.claim(notice.id, runId)) {
            declined = true;
            throw new AlreadyConsumed("Completion is no longer pending");
          }
          // Stop, approval, disposal and handoff can intervene during the claim.
          allowed(parent);
          if (!idle(host, parent)) throw new TaskPreSpawnError("Parent changed before delivery");
        }, undefined, beforeNative, beforeNative);
      if (!claimedRun || ack.runId !== claimedRun) throw new Error("Parent continuation ACK did not match its claim");
      if (!await deps.resolve(notice.id, runId, "delivered")) throw new Error("Parent continuation receipt changed");
      pending.delete(notice.id);
    } catch (error) {
      if (declined) { pending.delete(notice.id); return; }
      if (error instanceof TaskPreSpawnError) {
        const stopped = deps.blocked(parent) === "stopped" || host.wasInterrupted(parent);
        deferred.add(notice.id);
        if (claimedRun) await deps.resolve(notice.id, runId, stopped ? "cancelled" : "retry");
        if (stopped) pending.delete(notice.id);
        // Native changes caused by the retry must not create a busy retry loop.
        return;
      }
      pending.delete(notice.id);
      deferred.add(notice.id);
      // The beforeDelivery fence precedes every native turn/live delivery.
      if (claimedRun) await deps.resolve(notice.id, runId, "unknown");
      deps.error();
    } finally { starts--; activeStarts.delete(notice.id); }
  }

  function drain(): Promise<void> {
    if (disposed || deps.paused() || !pending.size) return Promise.resolve();
    if (draining) { wakeAgain = true; return draining; }
    draining = (async () => {
      const host = await deps.host();
      await host.ready();
      do {
        wakeAgain = false;
        const parents = new Set<string>();
        for (const notice of [...pending.values()]) {
          if (disposed || deps.paused()) break;
          const parent = deps.target?.(notice.parent) ?? notice.parent;
          const parentKey = JSON.stringify(parent);
          if (parents.has(parentKey)) continue;
          const blocked = deps.blocked(parent);
          if (blocked === "stopped" || host.wasInterrupted(parent)) {
            await deps.resolve(notice.id, deps.runId(), "cancelled");
            pending.delete(notice.id);
            continue;
          }
          if (deferred.has(notice.id)) continue;
          if (blocked || !host.known(parent)) continue;
          if (host.inspect(parent) === null) await host.openBackground(parent);
          if (disposed || deps.paused() || deps.blocked(parent) || !idle(host, parent)) continue;
          parents.add(parentKey);
          await deliver(host, notice, parent);
        }
      } while (wakeAgain && !disposed && !deps.paused());
    })().catch(() => { if (!disposed) deps.error(); }).finally(() => { draining = undefined; });
    return draining;
  }

  function refresh(): Promise<void> {
    if (disposed || deps.paused()) return Promise.resolve();
    refreshAgain = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const notices = await deps.list();
        if (disposed || deps.paused()) return;
        if (!Array.isArray(notices)) throw new Error("Invalid native parent completion outbox");
        for (const notice of notices) {
          if ((notice.state === "unknown" || notice.state === "starting" && !activeStarts.has(notice.id)) && !reportedUnknown.has(notice.id)) {
            reportedUnknown.add(notice.id); deps.error();
          }
        }
        pending = new Map(notices.filter(n => n.state === "pending").map(n => [n.id, n]));
        const retained = new Set(notices.map(notice => notice.id));
        for (const id of reportedUnknown) if (!retained.has(id)) reportedUnknown.delete(id);
        for (const id of deferred) if (!pending.has(id)) deferred.delete(id);
        await drain();
      } while (refreshAgain && !disposed && !deps.paused());
    })().catch(() => { if (!disposed) deps.error(); }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  return {
    refresh,
    wake() { deferred.clear(); void drain(); },
    parents: () => [...pending.values()].map(notice => notice.parent),
    readiness: () => starts ? ["parent-continuation-start-unpublished"] : [],
    dispose() { disposed = true; pending.clear(); },
  };
}

/** Stop is cancellation; existing permission/cost reviews retain the notice. */
export function parentWakeupBlocked(parent: TaskSessionRef): "stopped" | "held" | false {
  const key = sessionKey(parent.engine, parent.sessionId, parent.workspacePath);
  const session = useChatStore.getState().bySession[key];
  if (session?.interrupted || session?.queueParked) return "stopped";
  if (useSessionSendCostGuardStore.getState().bySessionKey[key]) return "held";
  if (useCrossSessionActivityStore.getState().records.some(record => record.status === "awaiting_cost_approval" &&
    record.target.engine === parent.engine && record.target.sessionId === parent.sessionId &&
    sameLeaderWorkspace(record.target.workspacePath, parent.workspacePath))) return "held";
  return false;
}

export function startParentWakeupRuntime() {
  if (isWeb) return { refresh: async () => {}, dispose() {} };
  const runtime = createParentWakeupRuntime({
    host: desktopTaskFacade,
    list: () => invoke<ParentWakeup[]>("task_parent_wakeups", {}),
    claim: (id, runId) => invoke<boolean>("task_claim_parent_wakeup", { id, runId }),
    resolve: (id, runId, outcome) => invoke<boolean>("task_resolve_parent_wakeup", { id, runId, outcome }),
    blocked: parentWakeupBlocked,
    target: parent => {
      const tab = useChatStore.getState().openTabs.find(tab => tab.engine === parent.engine && tab.sessionId === parent.sessionId &&
        sameLeaderWorkspace(tab.workspacePath, parent.workspacePath));
      return tab ? { ...parent, workspacePath: tab.workspacePath } : parent;
    },
    paused: runtimeCheckpoint.isPaused,
    runId: () => `run-${newId()}`,
    prompt: notice => i18n.t("leader.parentWakeupMessage", { branchId: notice.branchId, requestId: notice.requestId }),
    error: () => useLeaderStore.setState({ error: i18n.t("leader.parentWakeupFailed") }),
  });
  const offChat = useChatStore.subscribe((state, previous) => {
    // Text chunks alone do not need a native read or a scheduling pass.
    const parents = runtime.parents();
    if (!parents.length) return;
    if (state.openTabs !== previous.openTabs || state.initialized !== previous.initialized ||
      state.models !== previous.models || state.efforts !== previous.efforts || state.providers !== previous.providers ||
      state.permission !== previous.permission || state.defaultClaudeUltracode !== previous.defaultClaudeUltracode ||
      state.archivedSessionKeys !== previous.archivedSessionKeys || state.streamingByKey !== previous.streamingByKey ||
      parents.some(parent => {
        const key = sessionKey(parent.engine, parent.sessionId, parent.workspacePath);
        const next = state.bySession[key], before = previous.bySession[key];
        return next !== before && (!next || !before || next.queue !== before.queue || next.interrupted !== before.interrupted ||
          next.queueParked !== before.queueParked || next.loading !== before.loading || next.draftLaunching !== before.draftLaunching ||
          next.nativeActivity !== before.nativeActivity || next.liveLaunch !== before.liveLaunch ||
          (!next.streaming || next.nativeActivity === "waiting") && next.messages !== before.messages);
      })) runtime.wake();
  });
  const offCosts = useSessionSendCostGuardStore.subscribe(() => runtime.wake());
  const offComms = useCrossSessionActivityStore.subscribe((next, previous) => {
    if (!runtime.parents().length) return;
    const held = (records: typeof next.records) => records.filter(r => r.status === "awaiting_cost_approval").map(r => r.scopedId).sort().join("\n");
    if (held(next.records) !== held(previous.records)) runtime.wake();
  });
  const offCheckpoint = runtimeCheckpoint.register({
    id: "task-parent-wakeup", capture: () => ({ version: 1 }),
    restore(value) { if ((value as { version?: number })?.version !== 1) throw new Error("Invalid parent completion checkpoint"); },
    readiness: runtime.readiness,
    resumed: () => { runtime.wake(); void runtime.refresh(); },
  });
  return { refresh: runtime.refresh, dispose() { runtime.dispose(); offChat(); offCosts(); offComms(); offCheckpoint(); } };
}
