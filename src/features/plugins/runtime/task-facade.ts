import { matchesHostTaskSelection, type HostLaunchChoices } from "@/features/chat/store/host-task-selection";
import type { Disposer } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import type { Message, SessionMeta } from "@/lib/ipc";
import type { EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { sameTaskPath } from "./task-paths";
import { nativeFixedInstructionsSupported } from "./fixed-instructions";
import type { HostTaskConversationAction } from "@ccgui/plugin-sdk";
import type { LeaderBranch } from "@/features/leader/types";
import type { HostUserRowIdentity } from "@/features/chat/store/types";
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

export interface HostTaskFacade {
  conversationState?(ref: TaskSessionRef): { messages: Message[]; runId: string | null; status: TaskTimelineStatus; canDeliver: boolean } | null;
  continueMessage?(ref: TaskSessionRef, prompt: string, images: string[], runId: string, beforeDelivery: (delivery: "turn" | "steer" | "live", runId: string) => Promise<void>, launch?: TaskLaunchChoices, onUserRow?: UserRowCallback): Promise<{ delivery: "turn" | "steer" | "live"; runId: string }>;
  conversationAction?(ref: TaskSessionRef, action: HostTaskConversationAction): Promise<void>;
  stopChild?(parent: TaskSessionRef, id: string): Promise<void | LeaderBranch>;
  ready(): Promise<void>;
  fixedInstructionsSupported?(): Promise<boolean>;
  activeEngine(): string;
  engines(): TaskEngineInfo[];
  workspaces(): TaskWorkspaceInfo[];
  sessions(): SessionMeta[];
  /** Saved chat exists (catalog or open tab) in exactly this workspace and is not archived. */
  known(ref: TaskSessionRef): boolean;
  /** Open and loaded timeline only; null otherwise. */
  inspect(ref: TaskSessionRef): TaskTimelineStatus | null;
  /** Open a saved chat as a background tab and load it (never focuses). */
  openBackground(ref: TaskSessionRef): Promise<void>;
  /** Open a pending chat in the background; false = the user holds that pending chat. */
  openDraft(engine: string, workspacePath: string, launch: TaskLaunchChoices): boolean;
  /** Pending chat for engine+workspace is open, idle and free of user draft occupation. */
  draftReady(engine: string, workspacePath: string, launch?: TaskLaunchChoices): boolean;
  selectionMatches?(ref: TaskSessionRef, launch: TaskLaunchChoices): boolean;
  sendExisting(ref: TaskSessionRef, prompt: string, runId: string, launch?: TaskLaunchChoices, beforeSend?: () => Promise<void>, imagePaths?: string[], onUserRow?: UserRowCallback): Promise<TaskAck>;
  sendNew(engine: string, workspacePath: string, prompt: string, runId: string, launch?: TaskLaunchChoices, beforeSend?: () => Promise<void>, imagePaths?: string[], onUserRow?: UserRowCallback): Promise<TaskAck>;
  /** The chat store still routes this run in this document: the session key it routes to. */
  liveRun(runId: string): string | null;
  /** Native terminal proof recorded by the chat store for a finished run in this document. */
  settledRun(runId: string, ref?: TaskSessionRef | null): TaskSettledRun | null;
  /** True only when real native context/compaction evidence indicates the session should roll over. */
  sessionShouldRollover(ref: TaskSessionRef): boolean;
  /** Stop a running turn only when it is this run. */
  interrupt(runId: string): Promise<boolean>;
  wasInterrupted(ref: TaskSessionRef): boolean;
  focus(ref: TaskSessionRef): Promise<void>;
  focusDraft(engine: string, workspacePath: string): void | Promise<void>;
  subscribe(callback: () => void): Disposer;
  listen(callback: (events: EngineEventPayload[]) => void): Promise<Disposer>;
  leaderBranches(includeReclaimed?: boolean): Promise<Array<Pick<LeaderBranch, "parentEngine" | "parentSessionId" | "engine" | "sessionId" | "workspacePath" | "state"> & Partial<LeaderBranch>>>;
  loadPage(ref: TaskSessionRef, limit: number, before: number | null): Promise<{ messages: Message[]; nextBefore: number | null }>;
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

export function desktopTaskFacade(): Promise<HostTaskFacade> {
  return (cachedDesktopFacade ??= (async () => {
  const [
    { useChatStore, sessionKey },
    { runRouting },
    { HostChatBusyError },
    { isBackgroundDraftAvailable },
    { settledRunOutcomes },
    { latestMessageUsage, parseUsage, reportedContextWindow, selectCursorContext },
    events,
    { ipc },
    { codexSteerBlocker, liveFollowUpBlocker },
    { useLeaderStore },
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
  ]);
  const state = () => useChatStore.getState();
  let childSnapshotReady: Promise<void> | undefined;
  const tabOf = (ref: TaskSessionRef) =>
    state().openTabs.find((t) => t.engine === ref.engine && t.sessionId === ref.sessionId && t.workspacePath === ref.workspacePath);
  const draftOf = (engine: string, workspacePath: string) =>
    state().openTabs.find((t) => t.engine === engine && t.sessionId === null && t.workspacePath === workspacePath);
  const awaiting = (messages: Message[]) => messages.some((m) => m.question?.status === "pending" || m.grant?.status === "pending" ||
    m.planReview?.status === "awaiting_review" || m.planReview?.status === "deferred" || m.planReview?.status === "submitting");
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
  return {
    conversationState(ref) {
      const tab = tabOf(ref);
      const session = state().bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)];
      if (!tab || !session || session.loading || state().archivedSessionKeys[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)]) return null;
      return { messages: session.messages, runId: session.codexRunId ?? session.nativeTaskRunId ?? null,
        status: awaiting(session.messages) ? "awaiting_permission" : session.streaming || session.queue.length ? "busy" : "idle",
        canDeliver: !session.queue.length && !awaiting(session.messages) && (!session.streaming ||
          !codexSteerBlocker(state(), tab, session) || !liveFollowUpBlocker(state(), tab, session)),
      };
    },
    async continueMessage(ref, prompt, images, runId, beforeDelivery, launch, onUserRow) {
      const tab = tabOf(ref);
      if (!tab) throw new TaskPreSpawnError("Exact conversation is not open");
      let received: { delivery: "turn" | "steer" | "live"; runId: string } | undefined;
      try {
        await state().sendWhileBusy(prompt, images, {
          requestedRunId: runId, hostLaunch: launch,
          ...(onUserRow ? { hostUserRow: onUserRow } : {}),
          onRunStarted(result) {
            if (result.runId !== runId || (result.sessionId !== null && result.sessionId !== ref.sessionId)) throw new Error("Native continuation identity mismatch; not rebound");
          },
          hostContinuation: { beforeDelivery, onReceived: (delivery, id) => { received = { delivery, runId: id }; } },
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
      if (s.archivedSessionKeys[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)]) return false;
      return !!tabOf(ref) || s.sessions.some((m) => m.engine === ref.engine && m.sessionId === ref.sessionId &&
        m.workspacePath === ref.workspacePath && !m.remote);
    },
    inspect(ref) {
      const s = state();
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      const session = s.bySession[key];
      if (!s.initialized || !tabOf(ref) || !session || session.loading || s.archivedSessionKeys[key]) return null;
      if (awaiting(session.messages)) return "awaiting_permission";
      return session.streaming || session.queue.length > 0 || session.draftLaunching ? "busy" : "idle";
    },
    async openBackground(ref) {
      const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
      if (!tabOf(ref) || !state().bySession[key]) {
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
    selectionMatches(ref, launch) {
      const tab = tabOf(ref);
      return !!tab && matchesHostTaskSelection(tab, state().bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)], launch);
    },
    async sendExisting(ref, prompt, runId, launch, beforeSend, imagePaths, onUserRow) {
      const tab = tabOf(ref);
      if (!tab) throw new TaskPreSpawnError("Task chat is no longer open");
      return capture((options) => state().send(prompt, imagePaths ?? [], { ...options, hostLaunch: launch, hostBeforeSend: beforeSend, ...(onUserRow ? { hostUserRow: onUserRow } : {}) }, tab), runId, false);
    },
    async sendNew(engine, workspacePath, prompt, runId, launch, beforeSend, imagePaths, onUserRow) {
      const tab = draftOf(engine, workspacePath);
      if (!tab) throw new TaskPreSpawnError("Task draft is no longer open");
      const hostLaunch = launch
        ? {
            ...(launch.model ? { model: launch.model } : {}),
            ...(launch.effort ? { effort: launch.effort as EffortLevel } : {}),
            ...(launch.providerId !== undefined ? { providerId: launch.providerId } : {}),
            ...(launch.defaultProvider !== undefined ? { defaultProvider: launch.defaultProvider } : {}),
            ...(launch.defaultModel !== undefined ? { defaultModel: launch.defaultModel } : {}),
            ...(launch.defaultEffort !== undefined ? { defaultEffort: launch.defaultEffort } : {}),
          }
        : undefined;
      return capture(
        (options) => state().send(prompt, imagePaths ?? [], { ...options, hostBeforeSend: beforeSend, ...(hostLaunch ? { hostLaunch } : {}), ...(onUserRow ? { hostUserRow: onUserRow } : {}) }, tab),
        runId,
        true,
      );
    },
    liveRun: (runId) => runRouting.get(runId) ?? null,
    settledRun(runId, ref) {
      if (!runId || runRouting.has(runId)) return null;
      const proof = settledRunOutcomes.get(runId);
      if (!proof || (ref && proof.key !== sessionKey(ref.engine, ref.sessionId, ref.workspacePath))) return null;
      if (proof.status === "failed") return { status: "failed", error: "Native engine failed" };
      return proof.status === "cancelled"
        ? { status: "cancelled", error: "Original GUI turn was interrupted" }
        : { status: "completed" };
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
      const key = runRouting.get(runId);
      if (!key) return false;
      const tab = state().openTabs.find((t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key);
      if (!tab || !state().bySession[key]?.streaming) return false;
      await state().interrupt(tab);
      return true;
    },
    wasInterrupted: (ref) => state().bySession[sessionKey(ref.engine, ref.sessionId, ref.workspacePath)]?.interrupted === true,
    async focus(ref) { await state().selectSession(ref.engine, ref.sessionId, ref.workspacePath); await focusWindow(); },
    async focusDraft(engine, workspacePath) {
      if (draftOf(engine, workspacePath)) {
        state().focusTab(engine, null, workspacePath);
        await focusWindow();
      }
    },
    subscribe: (callback) => { const a = useChatStore.subscribe(callback); const b = useLeaderStore.subscribe(callback); return () => { a(); b(); }; },
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
