import { matchesHostTaskSelection, type HostLaunchChoices } from "@/features/chat/store/host-task-selection";
import type { Disposer } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import type { Message, SessionMeta } from "@/lib/ipc";
import type { EffortLevel } from "@/components/application/ai-chat/effort-levels";
import type { HandoffProgressCallback } from "@/lib/handoff-progress";
import { sameTaskPath } from "./task-paths";
import { nativeFixedInstructionsSupported } from "./fixed-instructions";
import type { HostTaskConversationAction, HostTaskCostApproval, HostTaskSelection } from "@ccgui/plugin-sdk";
import type { TaskSessionCostEvaluation } from "./task-session-cost";
import type { LeaderBranch } from "@/features/leader/types";
import type { ChatStore, HostUserRowIdentity } from "@/features/chat/store/types";
import type { BackgroundDraftBlockReason } from "@/features/chat/store/tabs";
import type { SidechatStore } from "@/features/sidechat/store";
import i18n from "@/lib/i18n";
import { pendingHostOrigin } from "@/features/chat/store/host-pending-chat";
export type { HostUserRowIdentity } from "@/features/chat/store/types";
type UserRowCallback = (row: HostUserRowIdentity) => Promise<void>;

/** Host-only seam between the task bridge and the chat store. Plugins only
 * ever see the SDK `ctx.tasks` facade built on top of this. */

export interface TaskSessionRef { engine: string; sessionId: string; workspacePath: string }
export type TaskTimelineStatus = "idle" | "busy" | "awaiting_permission";
export interface TaskAck { runId: string; sessionId: string | null }
export interface TaskWorkspaceInfo { id: string; path: string; name: string; remote: boolean; archived: boolean }
export interface TaskEngineInfo { id: string; available: boolean; enabled: boolean; supportsImages?: boolean; defaultModel: string | null; defaultEffort: string | null; defaultProvider?: string | null }
export interface TaskLaunchChoices extends HostLaunchChoices {}
export interface TaskSettledRun {
  status: "completed" | "failed" | "cancelled";
  error?: string;
}
/** Host-owned, exact terminal evidence retained with a stopped conversation. */
export interface TaskTerminalProof extends TaskSettledRun { runId: string; sessionRef: TaskSessionRef }
/** Fresh native ownership/liveness observation, independent of an open timeline. */
export interface TaskLifecycleObservation {
  archived: boolean;
  idle: boolean;
  isCurrent(): boolean;
}

export interface HostTaskFacade {
  /** Local cost facts for the exact owned coordinator; null means identity is unavailable. */
  sessionCostReview?(ref: TaskSessionRef): TaskSessionCostEvaluation | null;
  composerPrediction?(ref: TaskSessionRef): { id: number; text: string } | null;
  dismissComposerPrediction?(ref: TaskSessionRef, id: number): boolean;
  costApprovals?(refs: TaskSessionRef[]): { items: HostTaskCostApproval[]; truncated: boolean };
  captureCostApproval?(refs: TaskSessionRef[], expected: HostTaskCostApproval): { approval: HostTaskCostApproval; message: string; imageRefs?: string[]; kind: "leader" | "cross-session" };
  /** Read saved context without opening a chat or deciding its held request. */
  loadCostApprovalContext?(refs: TaskSessionRef[], expected: HostTaskCostApproval): Promise<HostTaskCostApproval | null>;
  /** Changes only with the exact target's saved history source or availability. */
  costContextVersion?(ref: TaskSessionRef): string;
  resolveCostApproval?(refs: TaskSessionRef[], expected: HostTaskCostApproval, decision: "approve" | "cancel" | "handoff", expectedMessage?: string): Promise<void>;
  handoffCostApproval?(refs: TaskSessionRef[], expected: HostTaskCostApproval, expectedMessage: string, summary: string, operationId: string, targetSelection?: HostTaskSelection): Promise<void>;
  managedChildHandoffSupported?(): Promise<boolean>;
  managedChildHandoffSelectionSupported?(): Promise<boolean>;
  resolveHandoffSelection?(selection: HostTaskSelection): Promise<HostTaskSelection>;
  /** Current choices of the exact native conversation, captured afresh for each continuation. */
  conversationLaunch?(ref: TaskSessionRef): TaskLaunchChoices | null;
  conversationState?(ref: TaskSessionRef, terminalProof?: TaskTerminalProof): { messages: Message[]; runId: string | null; status: TaskTimelineStatus; canDeliver: boolean; readyForQueuedInput?: boolean } | null;
  observeLifecycle?(ref: TaskSessionRef, options?: { forAttachment: true }): Promise<TaskLifecycleObservation | null>;
  continueMessage?(ref: TaskSessionRef, prompt: string, images: string[], runId: string, beforeDelivery: (delivery: "turn" | "steer" | "live", runId: string) => Promise<void>, launch?: TaskLaunchChoices, onUserRow?: UserRowCallback, beforeSpawn?: () => Promise<void>): Promise<{ delivery: "turn" | "steer" | "live"; runId: string }>;
  prepareImmediateMessage?(ref: TaskSessionRef, expectedRunId: string | null): Promise<void>;
  conversationAction?(ref: TaskSessionRef, action: HostTaskConversationAction): Promise<void>;
  stopChild?(parent: TaskSessionRef, id: string): Promise<void | LeaderBranch>;
  ready(): Promise<void>;
  fixedInstructionsSupported?(engine?: string): Promise<boolean>;
  codexServiceTierOverrideSupported?(): Promise<boolean>;
  activeEngine(): string;
  engines(): TaskEngineInfo[];
  workspaces(): TaskWorkspaceInfo[];
  sessions(): SessionMeta[];
  /** Saved chat exists (catalog or open tab) in exactly this workspace and is not archived. */
  known(ref: TaskSessionRef): boolean;
  /** Open and loaded timeline only; null otherwise. */
  inspect(ref: TaskSessionRef): TaskTimelineStatus | null;
  /** No reply in flight; includes a Claude CLI waiting with background tasks. */
  idleForContinuation?(ref: TaskSessionRef): boolean;
  /** Open a saved chat as a background tab and load it (never focuses). */
  openBackground(ref: TaskSessionRef): Promise<void>;
  /** Open a pending chat in the background; false = the user holds that pending chat. */
  openDraft(engine: string, workspacePath: string, launch: TaskLaunchChoices): boolean;
  /** Pending chat for engine+workspace is open, idle and free of user draft occupation. */
  draftReady(engine: string, workspacePath: string, launch?: TaskLaunchChoices): boolean;
  /** Read-only explanation of the same draft guard; never opens, focuses or acquires a tab. */
  draftBlockReason?(engine: string, workspacePath: string, launch?: TaskLaunchChoices, options?: { requireOpenTab?: boolean }): BackgroundDraftBlockReason | null;
  selectionMatches?(ref: TaskSessionRef, launch: TaskLaunchChoices): boolean;
  sendExisting(ref: TaskSessionRef, prompt: string, runId: string, launch?: TaskLaunchChoices, beforeSend?: () => Promise<void>, imagePaths?: string[], onUserRow?: UserRowCallback): Promise<TaskAck>;
  sendNew(engine: string, workspacePath: string, prompt: string, runId: string, launch?: TaskLaunchChoices, beforeSend?: () => Promise<void>, imagePaths?: string[], onUserRow?: UserRowCallback): Promise<TaskAck>;
  /** New hosts allocate private first-turn state instead of a user draft slot. */
  sendNewIsolated?: HostTaskFacade["sendNew"];
  /** The chat store still routes this run in this document: the session key it routes to. */
  liveRun(runId: string): string | null;
  /** Native terminal proof recorded by the chat store for a finished run in this document. */
  settledRun(runId: string, ref?: TaskSessionRef | null): TaskSettledRun | null;
  /** Recover only verified native terminal evidence; unknown or changing owners
   * return null. inputOnly can settle an old input despite a newer native run,
   * but must never be used as proof that the current coordinator is idle. */
  recoverSettledRun?(runId: string, ref: TaskSessionRef, options?: { inputOnly: true }): Promise<TaskSettledRun | null>;
  /** Recheck current workspace/run ownership before using retained stop evidence. */
  canProjectTerminalRun?(runId: string, ref: TaskSessionRef): boolean;
  /** True only when real native context/compaction evidence indicates the session should roll over. */
  sessionShouldRollover(ref: TaskSessionRef): boolean;
  /** Stop a running turn only when it is this run. */
  interrupt(runId: string): Promise<boolean>;
  wasInterrupted(ref: TaskSessionRef): boolean;
  focus(ref: TaskSessionRef): Promise<void>;
  focusDraft(engine: string, workspacePath: string, options?: { requireBlockedDraft?: boolean }): void | Promise<void>;
  subscribe(callback: () => void): Disposer;
  listen(callback: (events: EngineEventPayload[]) => void): Promise<Disposer>;
  leaderBranches(includeReclaimed?: boolean): Promise<Array<Pick<LeaderBranch, "parentEngine" | "parentSessionId" | "engine" | "sessionId" | "workspacePath" | "state"> & Partial<LeaderBranch>>>;
  loadPage(ref: TaskSessionRef, limit: number, before: number | null): Promise<{ messages: Message[]; nextBefore: number | null }>;
  fullHistoryHandoffSupported?(): Promise<boolean>;
  summarizeHandoff?(ref: TaskSessionRef, selection: import("@ccgui/plugin-sdk").HostHandoffSelection, childContext?: string, onProgress?: HandoffProgressCallback): Promise<string>;
  projects(): Promise<Array<{ id: string; name: string; defaultPath: string; sourcePluginId?: string | null; members: Array<{ id: string; path: string; label: string; role: "development" | "reference"; status: "available" | "missing" | "changed" }> }>>;
  models(engine: string): Promise<Array<{ id: string; name: string | null; provider: string }>>;
}

export class TaskPreSpawnError extends Error {}

const SESSION_PROOF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude session ids are UUIDs; other engines' ids are opaque but bounded. */
export function plausibleSessionId(engine: string, id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\s\u0000-\u001f]/.test(id) &&
    (engine !== "claude" || SESSION_PROOF.test(id));
}

let cachedDesktopFacade: Promise<HostTaskFacade> | undefined;

/** Task routing observes draft occupation, never its concrete text. Keep every
 * other top-level change visible so delivery/permission/recovery dependencies
 * do not need to be maintained as a separate allowlist. */
function taskStateChanged(next: ChatStore, previous: ChatStore): boolean {
  const own = Object.prototype.hasOwnProperty;
  for (const key in next) {
    if (key !== "drafts" && own.call(next, key) &&
      (!own.call(previous, key) || !Object.is(next[key as keyof ChatStore], previous[key as keyof ChatStore]))) return true;
  }
  for (const key in previous) {
    if (key !== "drafts" && own.call(previous, key) && !own.call(next, key)) return true;
  }
  if (next.drafts === previous.drafts) return false;
  for (const key in next.drafts) {
    if (!own.call(next.drafts, key)) continue;
    const before = own.call(previous.drafts, key) ? previous.drafts[key] : undefined;
    if (next.drafts[key] !== before && !!next.drafts[key]?.trim() !== !!before?.trim()) return true;
  }
  for (const key in previous.drafts) {
    if (own.call(previous.drafts, key) && !own.call(next.drafts, key) && previous.drafts[key]?.trim()) return true;
  }
  return false;
}

function taskSidechatOccupationChanged(next: SidechatStore, previous: SidechatStore): boolean {
  for (const field of ["btwBySession", "sidechatBySession"] as const) {
    if (next[field] === previous[field]) continue;
    // Token/draft edits retain occupation. Only an added/removed pending owner
    // can change the new-chat guard; do not inspect sidechat content.
    for (const records of [next[field], previous[field]]) {
      for (const key of Object.keys(records)) {
        if (key.startsWith("new:") &&
          !!(next.btwBySession[key] || next.sidechatBySession[key]) !==
          !!(previous.btwBySession[key] || previous.sidechatBySession[key])) return true;
      }
    }
  }
  return false;
}

export function desktopTaskFacade(): Promise<HostTaskFacade> {
  return (cachedDesktopFacade ??= (async () => {
  const [
    { useChatStore, sessionKey },
    { runRouting, resolveSessionModel, resolveSessionEffort, resolveSessionProvider, isUnloadedHistory },
    { HostChatBusyError },
    { isBackgroundDraftAvailable, backgroundDraftBlockReason },
    { settledRunOutcomes },
    { latestMessageUsage, parseUsage, reportedContextWindow, selectCursorContext },
    events,
    { ipc },
    { codexSteerBlocker, liveFollowUpBlocker },
    { useLeaderStore },
    { useCrossSessionActivityStore },
    costReviews,
    sessionCosts,
    composerPrediction,
    { useSidechatStore },
    { getConversationModeState },
    { subscribeComposerImageDraftOccupation, hasComposerImageDraft },
  ] = await Promise.all([
    import("@/features/chat/store"),
    import("@/features/chat/store/stream"),
    import("@/features/chat/store/types"),
    import("@/features/chat/store/tabs"),
    import("@/features/chat/store/engine-events"),
    import("@/features/chat/usage"),
    import("@/lib/events"),
    import("@/lib/ipc"),
    import("@/features/chat/store/live-follow-up"),
    import("@/features/leader/store"),
    import("@/features/chat/cross-session"),
    import("./task-cost-review"),
    import("./task-session-cost"),
    import("@/features/chat/composer-prediction"),
    import("@/features/sidechat/store"),
    import("@/features/plugins/conversation/state"),
    import("@/features/chat/components/use-composer-images"),
  ]);
  const state = () => useChatStore.getState();
  let childSnapshotReady: Promise<void> | undefined;
  let terminalTransport: Promise<typeof import("@/lib/transport")> | undefined;
  const tabOf = (ref: TaskSessionRef) =>
    state().openTabs.find((t) => t.engine === ref.engine && t.sessionId === ref.sessionId && t.workspacePath === ref.workspacePath);
  const draftOf = (engine: string, workspacePath: string) =>
    state().openTabs.find((t) => t.engine === engine && t.sessionId === null && t.workspacePath === workspacePath);
  const awaiting = (messages: Message[], includeGrants = true) => messages.some((m) => m.question?.status === "pending" || (includeGrants && m.grant?.status === "pending") ||
    m.planReview?.status === "awaiting_review" || m.planReview?.status === "deferred" || m.planReview?.status === "submitting");
  const ambiguousOwner = (ref: TaskSessionRef) => [...state().openTabs, ...state().sessions].some(owner =>
    owner.engine === ref.engine && owner.sessionId === ref.sessionId && !sameTaskPath(owner.workspacePath, ref.workspacePath));
  const conversationLaunch = (ref: TaskSessionRef): TaskLaunchChoices | null => {
    const s = state(), tab = tabOf(ref), key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath), session = s.bySession[key];
    if (!s.initialized || !tab || !session || session.loading || isUnloadedHistory(session) || s.archivedSessionKeys[key] || ambiguousOwner(ref)) return null;
    const model = resolveSessionModel(tab, session), effort = resolveSessionEffort(tab, session), providerId = resolveSessionProvider(tab, session);
    return {
      ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(providerId !== undefined ? { providerId } : {}),
      defaultModel: s.models[ref.engine] || null, defaultEffort: s.efforts[ref.engine] ?? null, defaultProvider: s.providers?.[ref.engine] ?? null,
      expectedNativeSelection: { model: model ?? null, effort: effort ?? null, providerId: providerId ?? null },
    };
  };
  const terminalContext = (runId: string, ref: TaskSessionRef) => {
    const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
    const session = state().bySession[key];
    return !!runId && state().initialized && !!tabOf(ref) && !!session && !session.loading && !isUnloadedHistory(session) && !state().archivedSessionKeys[key] &&
      !ambiguousOwner(ref) && !runRouting.has(runId) && ![...runRouting.values()].includes(key) &&
      !session.streaming && !session.queue.length && !session.draftLaunching &&
      [session.codexRunId, session.nativeTaskRunId, session.throughput?.ended ? undefined : session.throughput?.runId].every(id => !id || id === runId);
  };
  const lifecycleFlights = new Set<string>();
  const observeLifecycle: NonNullable<HostTaskFacade["observeLifecycle"]> = async (ref, options) => {
    ref = { ...ref };
    const unavailable = (code: string): null => {
      if (options?.forAttachment) throw new Error(i18n.t("taskAttachment.lifecycleDiagnostic", { code }));
      return null;
    };
    if (!state().initialized) return unavailable("CHAT_NOT_READY");
    if (ambiguousOwner(ref)) return unavailable("CONFLICTING_WORKSPACE");
    if (typeof ipc.taskSessionLifecycle !== "function") return unavailable("NATIVE_API_UNAVAILABLE");
    const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
    const flightKey = JSON.stringify([ref.engine, ref.sessionId, ref.workspacePath]);
    if (lifecycleFlights.has(flightKey)) return unavailable("OBSERVATION_PENDING");
    if (lifecycleFlights.size >= 32) return unavailable("OBSERVATION_CAPACITY");
    let lastSnapshot: ReturnType<typeof useLeaderStore.getState>["snapshot"] | undefined;
    let lastLeaderStamp = "";
    const leaderStamp = () => {
      const snapshot = useLeaderStore.getState().snapshot;
      if (snapshot === lastSnapshot) return lastLeaderStamp;
      const reachable = new Set([`${ref.engine}/${ref.sessionId}`]), seen = new Set<string>();
      const rows: unknown[] = [];
      for (let added = true; added;) {
        added = false;
        for (const branch of snapshot.branches) {
          if (seen.has(branch.id) || !reachable.has(`${branch.parentEngine}/${branch.parentSessionId}`)) continue;
          seen.add(branch.id); added = true;
          rows.push([branch.id, branch.state, branch.runId, branch.engine, branch.sessionId, branch.workspacePath,
            branch.parentEngine, branch.parentSessionId, branch.parentWorkspacePath]);
          if (branch.sessionId && branch.state !== "reclaimed") reachable.add(`${branch.engine}/${branch.sessionId}`);
        }
      }
      const groups = (snapshot.archivedGroups ?? []).filter(group => group.members.some(member => member.engine === ref.engine && member.sessionId === ref.sessionId));
      const parents = snapshot.branches.filter(branch => branch.engine === ref.engine && branch.sessionId === ref.sessionId)
        .map(branch => [branch.id, branch.state, branch.parentEngine, branch.parentSessionId, branch.parentWorkspacePath, branch.workspacePath]);
      lastSnapshot = snapshot;
      return lastLeaderStamp = JSON.stringify([rows, parents, groups.map(group => [group.root, group.archivedAt, group.deletionStarted, group.members, group.branchIds])]);
    };
    const capture = () => ({
      initialized: state().initialized, session: state().bySession[key], archived: !!state().archivedSessionKeys[key],
      tabs: state().openTabs.filter(t => t.engine === ref.engine && t.sessionId === ref.sessionId),
      sessions: state().sessions.filter(t => t.engine === ref.engine && t.sessionId === ref.sessionId),
      leader: leaderStamp(), leaderError: useLeaderStore.getState().error,
      routes: JSON.stringify([...runRouting].filter(([, route]) => route === key)),
    });
    const before = capture();
    // Attaching active chats requires stable identity/activity, not frozen
    // streamed text. Negative idle proofs retain the stronger timeline fence.
    const activity = (session: typeof before.session) => JSON.stringify(session && [session.loading, session.streaming,
      session.queue.length, session.draftLaunching, session.codexRunId, session.nativeTaskRunId, session.throughput?.runId]);
    const beforeActivity = activity(before.session);
    type LifecycleOwner = { engine: string; sessionId: string | null; workspacePath: string };
    const sameOwner = (next: LifecycleOwner, previous: LifecycleOwner) => next.engine === previous.engine &&
      next.sessionId === previous.sessionId && sameTaskPath(next.workspacePath, previous.workspacePath) &&
      Boolean("remote" in next && next.remote) === Boolean("remote" in previous && previous.remote);
    if (before.leaderError) return unavailable("TASK_SNAPSHOT_UNAVAILABLE");
    if (before.sessions.some(s => s.remote)) return unavailable("REMOTE_SOURCE");
    let changed = false;
    const current = () => {
      const next = capture();
      return !changed && next.initialized && (next.session === before.session || options?.forAttachment === true && activity(next.session) === beforeActivity) && next.archived === before.archived &&
        next.leader === before.leader && next.leaderError === before.leaderError && next.routes === before.routes &&
        next.tabs.length === before.tabs.length && next.tabs.every((t, i) => options?.forAttachment === true ? sameOwner(t, before.tabs[i]) : t === before.tabs[i]) &&
        next.sessions.length === before.sessions.length && next.sessions.every((t, i) => options?.forAttachment === true ? sameOwner(t, before.sessions[i]) : t === before.sessions[i]) && !ambiguousOwner(ref);
    };
    const observe = () => { if (!current()) changed = true; };
    const a = useChatStore.subscribe(observe), b = useLeaderStore.subscribe(observe);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      lifecycleFlights.add(flightKey);
      const query = Promise.resolve().then(() => ipc.taskSessionLifecycle(ref)).then(value => ({ value }), error => ({ error })).finally(() => lifecycleFlights.delete(flightKey));
      const result = await Promise.race([
        query,
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 5000); }),
      ]);
      if (!result) return unavailable("NATIVE_TIMEOUT");
      if ("error" in result) {
        // Only stable, known reasons cross into UI. Arbitrary native error text
        // may include paths or other private data and is not interpolated.
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        const reasons: Record<string, string> = {
          "Task lifecycle workspace is missing or ambiguous": "NATIVE_WORKSPACE_MISMATCH",
          "Task lifecycle source workspace does not match": "NATIVE_SOURCE_WORKSPACE_MISMATCH",
          "Task lifecycle source identity is unavailable": "NATIVE_SOURCE_UNAVAILABLE",
          "Task lifecycle requires a local workspace": "NATIVE_REMOTE_WORKSPACE",
          "Invalid task lifecycle identity": "NATIVE_IDENTITY_UNSUPPORTED",
          "Task lifecycle owner is unavailable": "NATIVE_OWNER_UNAVAILABLE",
          "Task lifecycle owner is shutting down": "NATIVE_OWNER_SHUTTING_DOWN",
          "Task lifecycle source is being deleted": "NATIVE_SOURCE_DELETING",
        };
        return unavailable(reasons[message] ?? "NATIVE_QUERY_FAILED");
      }
      if (!current()) return unavailable("SOURCE_CHANGED_DURING_CHECK");
      const value = result.value;
      if (!value || value.engine !== ref.engine || value.sessionId !== ref.sessionId ||
        typeof value.workspacePath !== "string" || !sameTaskPath(value.workspacePath, ref.workspacePath) || typeof value.archived !== "boolean" || typeof value.idle !== "boolean") return unavailable("INVALID_NATIVE_EVIDENCE");
      return { archived: value.archived, idle: value.idle, isCurrent: current };
    }
    finally { clearTimeout(timeout); a(); b(); }
  };
  const capture = async (send: (options: { requestedRunId: string; onRunStarted: (r: TaskAck) => void; hostNewChat?: true }) => Promise<void>, runId: string, hostNewChat: boolean) => {
    let started: TaskAck | undefined;
    try {
      await send({ requestedRunId: runId, onRunStarted: (result) => { started = result; }, ...(hostNewChat ? { hostNewChat: true as const } : {}) });
    } catch (error) {
      if (error instanceof HostChatBusyError && !started) throw new TaskPreSpawnError(error.message);
      throw error;
    }
    if (!started) throw new Error("Native task spawn acknowledgement is unavailable");
    return started;
  };
  const focusWindow = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.unminimize();
    await window.show();
    await window.setFocus();
  };
  const newSender = (independent: boolean): HostTaskFacade["sendNew"] => async (engine, workspacePath, prompt, runId, launch, beforeSend, imagePaths, onUserRow) => {
    const tab = independent ? { engine, sessionId: null, workspacePath,
      ...(launch?.model ? { model: launch.model } : {}),
      ...(launch?.effort ? { effort: launch.effort as EffortLevel } : {}),
      ...(launch?.providerId ? { provider: launch.providerId } : {}) } : draftOf(engine, workspacePath);
    if (!tab) throw new TaskPreSpawnError("Task draft is no longer open");
    const hostLaunch = launch ? {
      ...launch, ...(launch.effort ? { effort: launch.effort as EffortLevel } : {}),
    } : undefined;
    return capture(options => state().send(prompt, imagePaths ?? [], { ...options, hostBeforeSend: beforeSend,
      ...(independent ? { hostIndependentDraft: true as const } : {}), ...(hostLaunch ? { hostLaunch } : {}),
      ...(onUserRow ? { hostUserRow: onUserRow } : {}) }, tab), runId, true);
  };
  return {
    conversationLaunch,
    observeLifecycle,
    sessionCostReview(ref) {
      return sessionCosts.evaluateTaskSessionCost(ref, state());
    },
    composerPrediction(ref) {
      return ambiguousOwner(ref) ? null : composerPrediction.getComposerPredictionSnapshot(sessionKey(ref.engine, ref.sessionId, ref.workspacePath));
    },
    dismissComposerPrediction(ref, id) {
      if (ambiguousOwner(ref)) return false;
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      if (composerPrediction.getComposerPredictionSnapshot(key)?.id !== id) return false;
      composerPrediction.clearComposerPrediction(key); return true;
    },
    costApprovals: costReviews.projectTaskCostApprovals,
    captureCostApproval: costReviews.captureTaskCostApproval,
    loadCostApprovalContext: costReviews.loadTaskCostContext,
    costContextVersion: costReviews.taskCostContextVersion,
    handoffCostApproval: costReviews.handoffTaskCostApproval,
    managedChildHandoffSupported: () => import("@/lib/transport")
      .then(({ invoke }) => invoke<boolean>("task_managed_child_handoff_supported"))
      .then(value => value === true, () => false),
    managedChildHandoffSelectionSupported: () => import("@/lib/transport")
      .then(({ invoke }) => invoke<boolean>("task_managed_child_handoff_selection_supported"))
      .then(value => value === true, () => false),
    resolveHandoffSelection: selection => import("@/features/leader/cost-approval")
      .then(({ resolveHandoffTargetSelection }) => resolveHandoffTargetSelection(selection)),
    async resolveCostApproval(refs, expected, decision, expectedMessage) {
      await costReviews.resolveTaskCostApproval(refs, expected, decision, expectedMessage);
      if (decision === "handoff") {
        const { dismissCenterSurfaces } = await import("@/features/chat/center-surfaces");
        dismissCenterSurfaces();
        await focusWindow();
      }
    },
    conversationState(ref, terminalProof) {
      const tab = tabOf(ref);
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      const session = state().bySession[key];
      if (!tab || !session || session.loading || isUnloadedHistory(session) || state().archivedSessionKeys[key]) return null;
      const runId = session.codexRunId ?? session.nativeTaskRunId ?? (session.throughput?.ended ? null : session.throughput?.runId) ?? null;
      // Saved session keys omit workspace; visible conflicting owners make the
      // otherwise exact run proof ambiguous for this conversation.
      const durable = terminalProof && terminalProof.sessionRef.engine === ref.engine && terminalProof.sessionRef.sessionId === ref.sessionId &&
        sameTaskPath(terminalProof.sessionRef.workspacePath, ref.workspacePath) && terminalContext(terminalProof.runId, ref);
      const settled = durable || (!!runId && terminalContext(runId, ref) && settledRunOutcomes.get(runId)?.key === key);
      const active = session.streaming || session.queue.length > 0 || session.draftLaunching ||
        [...runRouting.values()].some(route => route === key);
      // A denied directory grant remains actionable for the next turn after the
      // exact native run ends. Keep its delivery gate, but not a running status.
      const historicalGrant = settled && !active;
      const status = awaiting(session.messages, !historicalGrant) ? "awaiting_permission" : active ? "busy" : "idle";
      return { messages: session.messages, runId: historicalGrant ? null : runId,
        status,
        // A Claude reply can finish while its process waits for background
        // tasks. That is a queue boundary, unlike Codex steering into a reply.
        readyForQueuedInput: status === "idle" || status === "busy" && !liveFollowUpBlocker(state(), tab, session),
        canDeliver: !session.queue.length && !awaiting(session.messages) && (!session.streaming ||
          !codexSteerBlocker(state(), tab, session) || !liveFollowUpBlocker(state(), tab, session)),
      };
    },
    async prepareImmediateMessage(ref, expectedRunId) {
      const tab = tabOf(ref);
      if (!tab) throw new TaskPreSpawnError(i18n.t("chat.steerUnavailable"));
      try { await state().prepareImmediateFollowUp(tab, expectedRunId); }
      catch (error) {
        if (error instanceof HostChatBusyError) throw new TaskPreSpawnError(error.message);
        throw error;
      }
    },
    async continueMessage(ref, prompt, images, runId, beforeDelivery, launch, onUserRow, beforeSpawn) {
      const tab = tabOf(ref);
      if (!tab) throw new TaskPreSpawnError("Exact conversation is not open");
      // The initial task launch is immutable history, not a permanent override
      // of this native chat. Follow-ups use its current choices, frozen for this
      // preparation so the store's late selection checks still detect changes.
      const currentLaunch = conversationLaunch(ref);
      if (!currentLaunch) throw new TaskPreSpawnError("Exact conversation selection is unavailable");
      const continuationLaunch: TaskLaunchChoices = { ...currentLaunch,
        ...(launch?.codexServiceTierOverride !== undefined ? { codexServiceTierOverride: launch.codexServiceTierOverride } : {}),
      };
      let received: { delivery: "turn" | "steer" | "live"; runId: string } | undefined;
      let newTurn = false;
      try {
        await state().sendWhileBusy(prompt, images, {
          requestedRunId: runId, hostLaunch: continuationLaunch,
          ...(onUserRow ? { hostUserRow: onUserRow } : {}),
          ...(beforeSpawn ? { hostBeforeSend: async () => { if (newTurn) await beforeSpawn(); } } : {}),
          onRunStarted(result) {
            if (result.runId !== runId || (result.sessionId !== null && result.sessionId !== ref.sessionId)) throw new Error("Native continuation identity mismatch; not rebound");
          },
          hostContinuation: { beforeDelivery: async (delivery, id) => { await beforeDelivery(delivery, id); newTurn = delivery === "turn"; }, onReceived: (delivery, id) => { received = { delivery, runId: id }; } },
        }, tab);
      } catch (error) {
        if (error instanceof HostChatBusyError) throw new TaskPreSpawnError(error.message);
        throw error;
      }
      if (!received) throw new Error("Native continuation acknowledgement is unavailable");
      return received;
    },
    async conversationAction(ref, action) {
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      const messages = state().bySession[key]?.messages ?? [];
      if (action.type === "openNative") { await state().selectSession(ref.engine, ref.sessionId, ref.workspacePath); await focusWindow(); return; }
      if (action.type === "openFile") {
        if (typeof action.path !== "string" || !action.path.trim() || action.path.length > 4096 || /[\u0000-\u001f]/.test(action.path)) throw new Error("Invalid conversation file link");
        const { desktopConversationFacade } = await import("./conversation-facade");
        await (await desktopConversationFacade()).openFile(ref.workspacePath, action.path); return;
      }
      if (action.type === "answerQuestion") {
        const q = messages.find(m => m.seq === action.seq)?.question;
        if (!q || q.status !== "pending" || q.submitting || q.runId !== action.runId || q.requestId !== action.requestId ||
            runRouting.get(q.runId) !== key) throw new Error("Stale native question");
        if (action.answers !== null) {
          const answers = action.answers;
          const keys = answers && typeof answers === "object" && !Array.isArray(answers) ? Object.keys(answers) : [];
          if (!keys.length || keys.length > 32 || keys.some(k => !q.codexApproval && !q.questions.some(question => question.question === k)) ||
            Object.values(answers).some(value => typeof value === "string" ? value.length > 12000 : !Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || v.length > 12000))) throw new Error("Invalid native question answers");
        }
        await state().respondToQuestion(key, action.seq, action.answers);
        const latest = state().bySession[key]?.messages.find(m => m.seq === action.seq)?.question;
        if (latest?.status === "pending") throw new Error(latest.error || "Native question answer was not accepted");
        return;
      }
      if (action.type === "answerGrant") {
        if (typeof action.accept !== "boolean") throw new Error("Invalid native grant response");
        if (messages.find(m => m.seq === action.seq)?.grant?.status !== "pending") throw new Error("Stale native grant");
        await state().respondToGrant(key, action.seq, action.accept);
        if (state().bySession[key]?.messages.find(m => m.seq === action.seq)?.grant?.status === "pending") throw new Error("Native grant was not applied");
        return;
      }
      if (action.type === "answerPlan") {
        if (!["approve", "request_changes", "defer"].includes(action.decision) || (action.feedback !== undefined && (typeof action.feedback !== "string" || action.feedback.length > 12000))) throw new Error("Invalid native plan response");
        const plan = messages.find(m => m.planReview?.planId === action.planId)?.planReview;
        if (!plan || plan.revision !== action.planRevision || plan.runId !== action.runId || !["awaiting_review", "deferred"].includes(plan.status)) throw new Error("Stale native plan");
        const result = await state().respondToPlanReview(key, action.planId, action.planRevision, action.decision, action.feedback);
        if (result.kind !== "applied") throw new Error(result.kind === "error" ? result.error : "Stale native plan revision");
        return;
      }
      throw new Error("Unsupported native conversation action");
    },
    async stopChild(parent, id) { return useLeaderStore.getState().act(parent, id, "stop"); },
    async ready() {
      for (let i = 0; i < 200 && !state().initialized; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!state().initialized) throw new Error("Chat host is not initialized");
    },
    fixedInstructionsSupported: nativeFixedInstructionsSupported,
    codexServiceTierOverrideSupported: () => import("@/lib/transport")
      .then(({ invoke }) => invoke<boolean>("codex_service_tier_override_supported"))
      .then(value => value === true, () => false),
    activeEngine: () => state().activeEngine,
    engines: () => state().engines.map((e) => ({
      id: e.id, available: e.available, enabled: e.enabled, supportsImages: Boolean(e.supportsImages),
      defaultModel: state().models[e.id] || null, defaultEffort: state().efforts[e.id] ?? null,
      defaultProvider: state().providers?.[e.id] ?? null,
    })),
    workspaces: () => state().workspaces.map((w) => ({
      id: w.id, path: w.path, name: w.name,
      remote: !!(w.meta && typeof w.meta === "object" && "wsl" in w.meta),
      archived: state().archivedWorkspaces.includes(w.id),
    })),
    sessions: () => state().sessions,
    known(ref) {
      const s = state();
      if (ambiguousOwner(ref)) return false;
      if (s.archivedSessionKeys[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)]) return false;
      return s.openTabs.some((t) => t.engine === ref.engine && t.sessionId === ref.sessionId && sameTaskPath(t.workspacePath, ref.workspacePath)) || s.sessions.some((m) => m.engine === ref.engine && m.sessionId === ref.sessionId &&
        sameTaskPath(m.workspacePath, ref.workspacePath) && !m.remote);
    },
    inspect(ref) {
      const s = state();
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      const session = s.bySession[key];
      if (!s.initialized || !tabOf(ref) || !session || session.loading || isUnloadedHistory(session) || s.archivedSessionKeys[key]) return null;
      if (awaiting(session.messages)) return "awaiting_permission";
      return session.streaming || session.queue.length > 0 || session.draftLaunching ? "busy" : "idle";
    },
    idleForContinuation(ref) {
      const tab = tabOf(ref), s = state();
      const session = s.bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)];
      if (!s.initialized || !tab || !session || session.loading || isUnloadedHistory(session) || ambiguousOwner(ref) ||
        s.archivedSessionKeys[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)] ||
        session.queue.length || session.draftLaunching || session.interrupted || session.queueParked || awaiting(session.messages)) return false;
      return !session.streaming || !liveFollowUpBlocker(s, tab, session);
    },
    async openBackground(ref) {
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      if (state().archivedSessionKeys[key]) return;
      if (!tabOf(ref) || !state().bySession[key] || isUnloadedHistory(state().bySession[key])) {
        await state().selectSession(ref.engine, ref.sessionId, ref.workspacePath, { background: true });
      }
      // A timeline another caller is still loading settles on its own; wait for it
      // (bounded) instead of reporting the chat as unopenable.
      for (let i = 0; i < 200 && state().bySession[key]?.loading; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    },
    openDraft: (engine, workspacePath, launch) =>
      state().openBackgroundDraft(engine, workspacePath, {
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.effort ? { effort: launch.effort as EffortLevel } : {}),
        ...(launch.providerId !== undefined ? { providerId: launch.providerId } : {}),
        ...(launch.defaultProvider !== undefined ? { defaultProvider: launch.defaultProvider } : {}),
        ...(launch.defaultModel !== undefined ? { defaultModel: launch.defaultModel } : {}),
        ...(launch.defaultEffort !== undefined ? { defaultEffort: launch.defaultEffort } : {}),
      }),
    draftReady(engine, workspacePath, launch) {
      return isBackgroundDraftAvailable(state(), engine, workspacePath, launch, { requireOpenTab: true });
    },
    draftBlockReason: (engine, workspacePath, launch, options) =>
      backgroundDraftBlockReason(state(), engine, workspacePath, launch, options),
    selectionMatches(ref, launch) {
      const tab = tabOf(ref);
      return !!tab && matchesHostTaskSelection(tab, state().bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)], launch);
    },
    async sendExisting(ref, prompt, runId, launch, beforeSend, imagePaths, onUserRow) {
      const tab = tabOf(ref);
      if (!tab || isUnloadedHistory(state().bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)])) throw new TaskPreSpawnError("Task chat is not open with loaded history");
      return capture((options) => state().send(prompt, imagePaths ?? [], { ...options, hostLaunch: launch, hostBeforeSend: beforeSend, ...(onUserRow ? { hostUserRow: onUserRow } : {}) }, tab), runId, false);
    },
    sendNew: newSender(false),
    sendNewIsolated: newSender(true),
    liveRun: (runId) => runRouting.get(runId) ?? null,
    canProjectTerminalRun: terminalContext,
    settledRun(runId, ref) {
      if (!runId || runRouting.has(runId)) return null;
      if (ref && ambiguousOwner(ref)) return null;
      const proof = settledRunOutcomes.get(runId);
      if (!proof || (ref && proof.key !== sessionKey(ref.engine, ref.sessionId, ref.workspacePath))) return null;
      if (proof.status === "failed") return { status: "failed", error: "Native engine failed" };
      return proof.status === "cancelled"
        ? { status: "cancelled", error: "Original GUI turn was interrupted" }
        : { status: "completed" };
    },
    async recoverSettledRun(runId, ref, options) {
      ref = { ...ref };
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      const timelineContext = () => options?.inputOnly
        ? !!runId && state().initialized && !!tabOf(ref) && !!state().bySession[key] && !state().bySession[key].loading && !isUnloadedHistory(state().bySession[key]) &&
          !state().archivedSessionKeys[key] && !ambiguousOwner(ref) && !runRouting.has(runId)
        : terminalContext(runId, ref);
      const lifecycle = timelineContext() ? null : await observeLifecycle(ref);
      const context = lifecycle ? () => lifecycle.idle && lifecycle.isCurrent() && !runRouting.has(runId) : timelineContext;
      if (!context()) return null;
      const session = state().bySession[key], tab = tabOf(ref);
      let changed = false;
      // Observe intervening changes, including a new turn which starts and ends
      // before the IPC resolves. A final idle snapshot alone is insufficient.
      const off = useChatStore.subscribe(() => {
        if (state().bySession[key] !== session || tabOf(ref) !== tab || !context()) changed = true;
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const { invoke } = await (terminalTransport ??= import("@/lib/transport"));
        const proof = await Promise.race([
          invoke<unknown>("runtime_worker_terminal_outcome", { runId, ...ref }),
          new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 30000); }),
        ]);
        if (changed || state().bySession[key] !== session || tabOf(ref) !== tab || !context() ||
          !proof || typeof proof !== "object" || !("status" in proof) ||
          !("runId" in proof) || proof.runId !== runId || !("engine" in proof) || proof.engine !== ref.engine ||
          !("sessionId" in proof) || proof.sessionId !== ref.sessionId ||
          !["completed", "failed", "cancelled"].includes(proof.status as string)) return null;
        return { status: proof.status as TaskSettledRun["status"] };
      } catch { return null; }
      finally { clearTimeout(timeout); off(); }
    },
    sessionShouldRollover(ref) {
      const s = state();
      const session = s.bySession?.[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)];
      if (!session) return false;
      if (session.compaction || session.messages?.some((m) => m.role === "user" && m.text.trim().startsWith("/compact"))) return true;
      const usage = session.usage ?? latestMessageUsage(session.messages ?? []);
      if (ref.engine === "cursor") {
        const cursor = selectCursorContext(usage);
        return Boolean(cursor.occupancyKnown && cursor.capacityKnown && typeof cursor.pct === "number" && cursor.pct >= 85);
      }
      const raw = usage && typeof usage === "object" && !Array.isArray(usage) ? (usage as Record<string, unknown>) : null;
      if (!raw || raw.usage_scope === "turn") return false;
      const parsed = parseUsage(raw);
      const window = parsed?.contextWindow ?? reportedContextWindow(raw);
      if (!parsed || typeof window !== "number" || !(window > 0)) return false;
      const promptTokens = parsed.input + parsed.cacheRead + parsed.cacheWrite;
      return promptTokens <= window * 1.05 && promptTokens / window >= 0.85;
    },
    async interrupt(runId) {
      const pending = Object.entries(state().bySession).find(([key, session]) => pendingHostOrigin(key, session)?.runId === runId);
      if (pending?.[1].settledRunIds?.includes(runId)) return false;
      if (pending && (pending[1].draftLaunching || pending[1].streaming)) {
        await state().interrupt(undefined, runId);
        return true;
      }
      const key = runRouting.get(runId);
      if (!key) return false;
      const tab = state().openTabs.find((t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key);
      if (!tab || !state().bySession[key]?.streaming) return false;
      await state().interrupt(tab);
      return true;
    },
    wasInterrupted: (ref) => state().bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)]?.interrupted === true,
    async focus(ref) { await state().selectSession(ref.engine, ref.sessionId, ref.workspacePath); await focusWindow(); },
    async focusDraft(engine, workspacePath, options) {
      const s = state(), key = sessionKey(engine, null, workspacePath);
      const workspaces = s.workspaces.filter(w => sameTaskPath(w.path, workspacePath));
      if (!s.initialized || workspaces.length !== 1 || s.archivedWorkspaces.includes(workspaces[0].id) ||
        workspaces[0].meta && typeof workspaces[0].meta === "object" && ("wsl" in workspaces[0].meta || "remote" in workspaces[0].meta) ||
        !s.engines.some(e => e.id === engine)) throw new Error(i18n.t("crossSession.pendingDraftUnavailable"));
      if (options?.requireBlockedDraft && !s.drafts[key]?.trim() && !hasComposerImageDraft(key)) {
        throw new Error(i18n.t("crossSession.pendingDraftChanged"));
      }
      if (!draftOf(engine, workspacePath)) {
        if (!options?.requireBlockedDraft) throw new Error(i18n.t("crossSession.pendingDraftUnavailable"));
        state().startNewChat(workspacePath, engine);
      }
      if (!draftOf(engine, workspacePath)) throw new Error(i18n.t("crossSession.pendingDraftUnavailable"));
      state().focusTab(engine, null, workspacePath);
      await focusWindow();
    },
    subscribe: (callback) => {
      const a = useChatStore.subscribe((next, previous) => { if (taskStateChanged(next, previous)) callback(); });
      const b = useLeaderStore.subscribe(callback);
      const c = useCrossSessionActivityStore.subscribe((next, previous) => { if (costReviews.taskCostApprovalsChanged(next.records, previous.records)) callback(); });
      const d = composerPrediction.subscribeComposerPrediction(callback);
      const e = useSidechatStore.subscribe((next, previous) => { if (taskSidechatOccupationChanged(next, previous)) callback(); });
      const f = getConversationModeState().subscribeOccupation(callback);
      const g = subscribeComposerImageDraftOccupation(callback);
      return () => { a(); b(); c(); d(); e(); f(); g(); };
    },
    listen: (callback) => events.listenEngineEvents(callback),
    async leaderBranches(includeReclaimed = false) {
      childSnapshotReady ??= useLeaderStore.getState().refresh().then(() => {
        if (useLeaderStore.getState().error) { childSnapshotReady = undefined; throw new Error("Native child snapshot is unavailable"); }
      });
      await childSnapshotReady;
      if (useLeaderStore.getState().error) throw new Error("Native child snapshot is unavailable");
      return useLeaderStore.getState().snapshot.branches.filter((b) => includeReclaimed || b.state !== "reclaimed");
    },
    async loadPage(ref, limit, before) {
      const page = before === null ? await ipc.loadSessionPage(ref.engine, ref.sessionId, limit)
        : await ipc.loadSessionPage(ref.engine, ref.sessionId, limit, before);
      return { messages: page.messages, nextBefore: page.nextBefore };
    },
    fullHistoryHandoffSupported: () => ipc.handoffFullHistorySupported().then(value => value === true, () => false),
    async summarizeHandoff(ref, compressionSelection, childContext, onProgress) {
      const saved = state().sessions.filter(meta => meta.engine === ref.engine && meta.sessionId === ref.sessionId);
      if (saved.length !== 1 || saved[0].remote || !sameTaskPath(saved[0].workspacePath, ref.workspacePath) ||
        state().archivedSessionKeys[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)] || ambiguousOwner(ref)) throw new Error("Handoff source is unavailable or ambiguous");
      const input = { engine: ref.engine, sessionId: ref.sessionId, historyScope: "full" as const, compressionSelection,
        ...(childContext ? { childContext } : {}) };
      return onProgress ? ipc.summarizeSessionHandoff(input, onProgress) : ipc.summarizeSessionHandoff(input);
    },
    async projects() {
      const { projectsApi } = await import("@/features/projects/api");
      return projectsApi.list();
    },
    async models(engine) {
      const catalog = await ipc.listEngineModels(engine);
      return catalog.models.map((m) => ({ id: m.id, name: m.name ?? null, provider: m.provider }));
    },
  };
  })());
}

/** Exact registered local workspace for a path, if any. */
export function registeredWorkspace(facade: Pick<HostTaskFacade, "workspaces">, path: string): TaskWorkspaceInfo | undefined {
  return facade.workspaces().find((w) => w.path === path) ?? facade.workspaces().find((w) => sameTaskPath(w.path, path));
}
