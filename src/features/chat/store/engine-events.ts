import { ipc, type Message, type QuestionSpec, type SessionMeta } from "@/lib/ipc";
import type { PlanReview, PlanReviewStatus } from "@/lib/ipc";
import type { EngineEventPayload, TurnCompletePayload } from "@/lib/events";
import {
  applyPlanDraft,
  applyPlanReview,
  applyPlanSettled,
} from "./plan-review";
import { errorText } from "@/lib/errors";
import { encodedModelEffort } from "@/components/application/ai-chat/model-effort";
import { desktopTaskMayContinue } from "../run-error";
import { abortAutoReviews, readAutoReview, upsertAutoReview } from "./auto-review";
import { dedupeTabs, persistTabs, sessionKey } from "./persistence";
import {
  EMPTY_SESSION,
  adoptedDraftKeys,
  appendToolMessages,
  applyStreamParts,
  bufferStreamPart,
  drainPending,
  migratePendingStream,
  moveRetryingFlag,
  moveStreamingFlag,
  patchSession,
  resolveSessionEffort,
  resolveSessionModel,
  rememberSettledRun,
  reconcileOrphanRuns,
  routeRun,
  runRouting,
  scheduleDeltaFlush,
  setRetryingFlag,
  setStreamingFlag,
  setNativeBackgroundActive,
  settleLiveRows,
  touchRun,
  untrackRun,
  updatePendingStreamModel,
  type HandoffState,
  type ToolMessageInput,
} from "./stream";
import type { ChatStore } from "../store";
import {
  ASK_OTHER_OPTION,
  askLoops,
  declaredMulti,
  openAskLoop,
  parseAskFrame,
  takeAskEditor,
  type AskLoop,
} from "./ask-loop";
import { mergeUsage, parseUsage, reportedContextWindow, type ParsedUsage } from "../usage";
import { usageTrackingEnabled } from "@/features/settings/usage-tracking";
import { migrateSelectedAgent } from "@/features/agents/selected-agent";
import { handleSideRunEvent, isSideRunEvent, migrateSidechatSessionKey } from "@/features/sidechat/store";
import { claimLeaderAssignment, emitLeaderStreamDelta, isReclaimedLeaderSession, leaderEventAllowed, markLeaderSession, rememberLeaderSession } from "@/features/leader/event-state";
import { beginNativeRun, mergeNativeTaskSnapshot, readNativeTasks } from "./native-tasks";
import { followUpGuardActive, runsEffort, runsModel } from "./live-follow-up";
import { persistClaudeUltracode } from "./claude-ultracode";
import { beginThroughput, mergeThroughput, parseThroughput, settleThroughput, updateThroughput, type ThroughputState } from "../throughput";
import {
  clearComposerPrediction,
  migrateComposerPredictionSessionKey,
  requestComposerPrediction,
} from "../composer-prediction";

// Sequence floors distinguish a new reply delivered to the same native run
// from samples already observed for its preceding reply. No store writes per delta.
const throughputEventSeqs = new Map<string, number>();
// Only event-created native placeholders may adopt a different provisional
// run's pending state (older backends choose their own run id). Existing native
// sessions never acquire this provenance, even when a pending tab is open.
const pendingSessionOrigins = new Map<string, { nativeKey: string; pendingKey: string; localRunId: string }>();
const MAX_PENDING_SESSION_ORIGINS = 256;
function localSessionRun(session: ChatStore["bySession"][string] | undefined) {
  return session?.codexRunId ?? session?.nativeTaskRunId ?? session?.throughput?.runId;
}
export function startThroughput(runId: string): ThroughputState {
  return beginThroughput(runId, throughputEventSeqs.get(runId) ?? -1);
}

function onThroughput(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const sample = parseThroughput(event.data);
  if (!sample || !((event.engine === "claude" && sample.source === "claude") ||
    (event.engine === "codex" && sample.source === "codex_app_server") ||
    (event.engine === "agy" && sample.source === "agy"))) return;
  const current = deps.get().bySession[key];
  if (current?.retiredNativeRunIds?.includes(event.runId)) return;
  // Sidecars cannot replace another run or revive the session's streaming flag.
  const owner = current?.throughput;
  if (owner && owner.runId !== event.runId) return;
  if (!owner && (current?.settledRunIds?.includes(event.runId) ||
    [...runRouting].some(([id, routed]) => routed === key && id !== event.runId))) return;
  if (!owner && runRouting.get(event.runId) !== key && current?.nativeTaskRunId !== event.runId) return;
  const before = owner ?? beginThroughput(event.runId);
  const next = updateThroughput(before, event.runId, event.seq, sample);
  if (next !== before) patchSession(deps.set, key, { throughput: next });
}

/**
 * Engine-event handling: the main loop resolves each event's session key and
 * dispatches to one handler per event kind. Store-agnostic apart from the
 * ChatStore type (type-only import, so no runtime cycle with store.ts);
 * everything the handlers need arrives through EngineEventDeps.
 */

/** Plan-review events ride the same run envelope, but the kind union in
 *  src/lib/events.ts is transport-owned (integration lead edits it), so the
 *  chat side widens the payload type locally. Unknown kinds are ignored. */
export type ChatEngineEvent = Omit<EngineEventPayload, "kind"> & {
  kind:
    | EngineEventPayload["kind"]
    | "plan_draft"
    | "plan_review"
    | "plan_review_settled";
};

export interface EngineEventDeps {
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void;
  get: () => ChatStore;
  /** After a turn ends, send the oldest queued message for that session. */
  drainQueue: (key: string) => void;
  /** The native CLI went idle with background tasks still running: hand the
   *  head of the queue to the live process (one item per idle boundary). */
  drainQueueLive?: (key: string) => void;
  /** Flag a finished background session for the sidebar's unseen dot. */
  markUnseenIfBackground: (key: string) => void;
  /** Insert/bump a freshly created session in the sidebar list cache. */
  upsertSessionMeta: (meta: SessionMeta) => void;
  /** Re-fetch the latest token usage from session history for the given session key. */
  refreshSessionUsage?: (key: string) => Promise<void>;
}

/** Collapse whitespace and cap a prompt for use as a session title. */
export function firstLineTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** List-cache entry for a session the backend scanner has not seen yet. */
export function optimisticMeta(
  engine: string,
  sessionId: string,
  workspacePath: string,
  title: string,
): SessionMeta {
  const now = Date.now();
  return {
    engine,
    sessionId,
    workspacePath,
    filePath: "",
    fileSize: 0,
    fileMtimeMs: 0,
    title,
    preview: "",
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    pinned: false,
    customTitle: null,
  };
}

/** Insert a freshly created session into the sidebar list cache (or bump its
 * timestamp when already present). Without this the row and the tab title
 * stayed missing/"新对话" until the post-turn rescan completed. */
export function upsertSessionMetaInto(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  meta: SessionMeta,
) {
  set((s) => {
    if (s.archivedSessionKeys[sessionKey(meta.engine, meta.sessionId, meta.workspacePath)]) {
      return {};
    }
    const idx = s.sessions.findIndex(
      (x) => x.engine === meta.engine && x.sessionId === meta.sessionId,
    );
    if (idx < 0) return { sessions: [meta, ...s.sessions] };
    const sessions = s.sessions.slice();
    sessions[idx] = { ...sessions[idx], updatedAt: meta.updatedAt };
    return { sessions };
  });
}

/** Effective model for event-stamped rows: the session's activeModel wins,
 * followed by the owning tab's per-tab override, then the session's own
 * history, then the engine default — the same resolveSessionModel the send
 * path uses, so a row can never claim a model the turn did not run. */
function stampedModel(
  deps: EngineEventDeps,
  engine: string,
  key: string,
): string | null {
  const s = deps.get();
  // Codex Desktop ran this turn with its own settings, not this tab's pick.
  const handoff = s.bySession[key]?.handoff;
  if (handoff) return handoff.model;
  const tab = s.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  return (
    resolveSessionModel(tab, s.bySession[key], s.models[engine]) || null
  );
}

/** Model for flushed chunks that carried none: the engine default, except
 *  while Codex Desktop runs the turn, when this tab's pick would be wrong. */
function flushModel(deps: EngineEventDeps, engine: string, key: string): string | null {
  return deps.get().bySession[key]?.handoff ? null : deps.get().models[engine] || null;
}

/** Effective reasoning effort for event-stamped rows. Native-session state
 * wins; a tab override is only valid before that session receives its id. */
function stampedEffort(
  deps: EngineEventDeps,
  engine: string,
  key: string,
): string | null {
  const s = deps.get();
  const handoff = s.bySession[key]?.handoff;
  if (handoff) return handoff.effort;
  const tab = s.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  const model = stampedModel(deps, engine, key);
  if (model && encodedModelEffort(engine, model)) return null;
  return resolveSessionEffort(tab, s.bySession[key], s.efforts[engine], s.models[engine]) || null;
}

function onModel(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const reported = typeof event.data === "string" ? event.data.trim() : "";
  if (!reported) return;
  // The engine reports the bare model name; our own record spells it
  // "provider/model" (see ipc.rememberSessionModel). Same model, more
  // context — keep the qualified one instead of dropping the provider.
  const current = deps.get().bySession[key]?.activeModel ?? "";
  const model =
    current === reported || current.endsWith(`/${reported}`) ? current : reported;
  const clearEffort = Boolean(encodedModelEffort(event.engine, model));
  updatePendingStreamModel(key, model, clearEffort ? null : undefined);
  deps.set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let messages = cur.messages;
    if (messages.some((m) => m.role === "assistant" && m.live)) {
      messages = messages.map((m) =>
        m.role === "assistant" && m.live
          ? { ...m, model, ...(clearEffort ? { effort: null } : {}) }
          : m,
      );
    }
    // A report is the CLI naming the model it runs (always the full id, which
    // can differ from the picker's spelling). The launch spelling stays as it
    // was; the reported one is recorded beside it, because the session refresh
    // later writes the remembered picker spelling back and both mean "still the
    // same model". A pick the user changed after launch is not a report: only a
    // resolved model the process already runs may be extended.
    let liveLaunch = cur.liveLaunch;
    if (liveLaunch) {
      const tab = s.openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
      );
      const before = resolveSessionModel(tab, cur, s.models[event.engine]) || null;
      if (runsModel(liveLaunch, before)) {
        const after =
          resolveSessionModel(tab, { ...cur, activeModel: model }, s.models[event.engine]) || null;
        liveLaunch = { ...liveLaunch, reportedModel: after };
      }
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          activeModel: model,
          ...(clearEffort ? { activeEffort: null } : {}),
          ...(liveLaunch ? { liveLaunch } : {}),
          messages,
        },
      },
    };
  });
}

function onEffort(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const reported = typeof event.data === "string" ? event.data.trim() : "";
  if (!reported) return;
  deps.set((s) => {
    const cur = s.bySession[key];
    if (!cur || cur.activeEffort === reported) return {};
    if (cur.activeModel && encodedModelEffort(event.engine, cur.activeModel)) return {};
    // Same as onModel: the report is what the live process runs, recorded
    // beside the launch spelling.
    let liveLaunch = cur.liveLaunch;
    if (liveLaunch) {
      const tab = s.openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
      );
      const before = resolveSessionEffort(tab, cur, s.efforts[event.engine], s.models[event.engine]) ?? null;
      if (runsEffort(liveLaunch, before)) {
        const after =
          resolveSessionEffort(tab, { ...cur, activeEffort: reported }, s.efforts[event.engine], s.models[event.engine]) ?? null;
        liveLaunch = { ...liveLaunch, reportedEffort: after };
      }
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: { ...cur, activeEffort: reported, ...(liveLaunch ? { liveLaunch } : {}) },
      },
    };
  });
}

/** Sessions whose run is inside a provider-retry backoff. Kept out of the
 *  store read path on purpose: the delta handlers test this set (O(1)) rather
 *  than reading `bySession` for every streamed token. */
const retryingKeys = new Set<string>();

function onDelta(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  resumeThroughput(event, key, deps);
  responseCompletedRuns.delete(event.runId);
  clearComposerPrediction(key, { resetTurn: true });
  // Content resumed: a re-issued request succeeded, so the retry chip goes.
  if (retryingKeys.has(key)) clearRetry(key, deps);
  bufferStreamPart(
    key,
    "delta",
    event.data as string,
    stampedModel(deps, event.engine, key),
    stampedEffort(deps, event.engine, key),
  );
  scheduleDeltaFlush(deps.set);
}

function onThinking(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  resumeThroughput(event, key, deps);
  responseCompletedRuns.delete(event.runId);
  clearComposerPrediction(key, { resetTurn: true });
  // Content resumed: a re-issued request succeeded, so the retry chip goes.
  if (retryingKeys.has(key)) clearRetry(key, deps);
  bufferStreamPart(
    key,
    "thinking",
    event.data as string,
    stampedModel(deps, event.engine, key),
    stampedEffort(deps, event.engine, key),
  );
  scheduleDeltaFlush(deps.set);
}

function onMessage(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  // Content resumed: a re-issued request succeeded, so the retry chip goes.
  if (retryingKeys.has(key)) clearRetry(key, deps);
  const data = event.data as {
    role: string;
    text: string;
    images?: string[];
  };
  if (data.role !== "assistant") return;
  resumeThroughput(event, key, deps);
  responseCompletedRuns.delete(event.runId);
  clearComposerPrediction(key, { resetTurn: true });
  // Full-snapshot assistant lines (kimi/codex non-delta) append as settled
  // messages; any live row above is finished growing.
  const pending = drainPending(key);
  deps.set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const settled = settleLiveRows(pending
      ? applyStreamParts(prev.messages, pending.parts,
          pending.model ?? flushModel(deps, event.engine, key),
          pending.effort ?? stampedEffort(deps, event.engine, key))
      : prev.messages);
    const seq = settled.length ? settled[settled.length - 1].seq + 1 : 1;
    const durationMs = prev.turnStartedAt
      ? Math.max(0, Date.now() - prev.turnStartedAt)
      : null;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...prev,
          messages: [
            ...settled,
            {
              role: "assistant",
              text: data.text,
              ...(data.images?.length ? { images: data.images } : {}),
              ts: new Date().toISOString(),
              model: stampedModel(deps, event.engine, key),
              effort: stampedEffort(deps, event.engine, key),
              durationMs,
              seq,
            },
          ],
        },
      },
    };
  });
}

/** Model a local send resolved for a session key, held until the run reports
 *  the native session id (`session` event) so the two can be remembered
 *  together — the engine transcript only carries the bare model name, and the
 *  new session's id is not known before that event. Only local sends fill
 *  this: an observer must never write its own (bare) reading of a run. */
const pendingSessionModels = new Map<string, string>();
/** Same hand-off for the reasoning level: it is chosen before the first send
 *  of a new session and can only be filed under the id the `session` event
 *  carries. */
const pendingSessionEfforts = new Map<string, string>();
/** Same hand-off for the in-app channel: spawn injects env from this id, and
 *  a brand-new session only learns its native id from the `session` event. */
const pendingSessionProviders = new Map<string, string>();

export function rememberModelForRun(
  key: string,
  model: string | null | undefined,
) {
  if (model) pendingSessionModels.set(key, model);
}

export function rememberEffortForRun(
  key: string,
  effort: string | null | undefined,
) {
  if (effort) pendingSessionEfforts.set(key, effort);
}

export function rememberProviderForRun(
  key: string,
  provider: string | null | undefined,
) {
  if (provider) pendingSessionProviders.set(key, provider);
}

function onSession(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  if (event.leader) return; // Managed sessions were adopted before run routing.
  const nativeId = event.data as string;
  // Resolve the workspace from the tab that owns this key — not from the
  // active tab. A first message sent on a background tab must not adopt the
  // foreground tab's workspace (the session would be orphaned there).
  const state = deps.get();
  const origin = pendingSessionOrigins.get(event.runId);
  pendingSessionOrigins.delete(event.runId);
  const originSession = origin ? state.bySession[origin.pendingKey] : undefined;
  const ownsOrigin = !!origin && originSession?.streaming === true &&
    localSessionRun(originSession) === origin.localRunId;
  const owner = state.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  const pendingCandidates = state.openTabs.filter(
    (t) =>
      t.engine === event.engine &&
      t.sessionId === null &&
      state.bySession[sessionKey(t.engine, null, t.workspacePath)] !==
        undefined,
  );
  // With several pending tabs of one engine, guessing would pin the session
  // onto an unrelated tab's workspace. Adopt only a unique candidate;
  // otherwise fall back to the active tab's workspace.
  const originTab = ownsOrigin ? pendingCandidates.find((t) =>
    sessionKey(t.engine, t.sessionId, t.workspacePath) === origin!.pendingKey) : undefined;
  const tab =
    originTab ?? owner ?? (pendingCandidates.length === 1 ? pendingCandidates[0] : undefined);
  const workspacePath =
    tab?.workspacePath ?? deps.get().active?.workspacePath ?? "";
  const newKey = sessionKey(event.engine, nativeId, workspacePath);
  // The event can resolve straight to the native key when it beat the send
  // response (the run had no routing entry yet). The turn rows and streaming
  // flag still sit under the pending key then; migrate from there instead of
  // orphaning them on a key nothing renders.
  const pendingKey = sessionKey(event.engine, null, workspacePath);
  const ownsPlaceholder = ownsOrigin && origin!.nativeKey === newKey && origin!.pendingKey === pendingKey;
  const fromKey =
    key === pendingKey ||
    (pendingKey !== newKey &&
      (!deps.get().bySession[newKey] || ownsPlaceholder) &&
      deps.get().bySession[pendingKey] !== undefined)
      ? pendingKey
      : key;
  if (fromKey !== newKey) {
    adoptedDraftKeys.set(fromKey, newKey);
  }
  if (event.engine === "claude") {
    const enabled = state.bySession[fromKey]?.claudeUltracode ?? state.bySession[newKey]?.claudeUltracode;
    if (enabled !== undefined) void persistClaudeUltracode(deps.set, enabled, nativeId);
  }

  const sentModel =
    pendingSessionModels.get(fromKey) ?? pendingSessionModels.get(key);
  if (sentModel) {
    pendingSessionModels.delete(fromKey);
    pendingSessionModels.delete(key);
    void ipc
      .rememberSessionModel?.(event.engine, nativeId, sentModel)
      ?.catch(() => {});
  }
  const sentEffort =
    pendingSessionEfforts.get(fromKey) ?? pendingSessionEfforts.get(key);
  if (sentEffort) {
    pendingSessionEfforts.delete(fromKey);
    pendingSessionEfforts.delete(key);
    void ipc
      .rememberSessionEffort?.(event.engine, nativeId, sentEffort)
      ?.catch(() => {});
  }
  const sentProvider =
    pendingSessionProviders.get(fromKey) ?? pendingSessionProviders.get(key);
  if (sentProvider) {
    pendingSessionProviders.delete(fromKey);
    pendingSessionProviders.delete(key);
    void ipc
      .rememberSessionProvider?.(event.engine, nativeId, sentProvider)
      ?.catch(() => {});
  }

  routeAndReconcileRun(deps.set, event.runId, newKey);
  // Unflushed stream chunks sit under the pre-migration key; move them too.
  migratePendingStream(fromKey, newKey);
  // Migrate pending key -> native key and stamp the owning pending tab atomically.
  deps.set((s) => {
    const shouldAdoptPendingTab = fromKey === pendingKey;
    // The pending tab owning this run adopts the native id. Stamp only the
    // first match: blanketing every pending tab of this engine+workspace
    // would turn a second "new chat" tab into a duplicate of this session
    // (identical React keys break the tab strip). Match by the resolved
    // workspace, so a background tab updates itself, not the foreground tab.
    let stamped = !shouldAdoptPendingTab;
    const openTabs = dedupeTabs(
      s.openTabs.map((t) => {
        if (
          stamped ||
          t.engine !== event.engine ||
          t.sessionId !== null ||
          t.workspacePath !== workspacePath
        ) {
          return t;
        }
        stamped = true;
        return { ...t, sessionId: nativeId, effort: undefined, provider: undefined, claudeUltracode: undefined };
      }),
    );
    const activeNext =
      shouldAdoptPendingTab &&
      s.active &&
      s.active.engine === event.engine &&
      s.active.sessionId === null &&
      s.active.workspacePath === workspacePath
        ? { ...s.active, sessionId: nativeId, effort: undefined, provider: undefined, claudeUltracode: undefined }
        : s.active;
    persistTabs(openTabs, activeNext);

    const prev = s.bySession[fromKey];
    if (!prev) return { openTabs, active: activeNext };
    const cur = s.bySession[newKey];
    const messages =
      cur && cur !== prev && cur.messages.length > 0
        ? [...prev.messages, ...cur.messages]
        : prev.messages;
    const throughput = mergeThroughput(prev.throughput, cur?.throughput);
    // prev (the sender's live turn under the pending key) owns the scalar
    // fields: queue, turnStartedAt, streaming and the active model/effort/
    // provider stamps. cur is a placeholder built from EMPTY_SESSION by
    // events that beat this session event to the native key — spreading it
    // last would silently drop a queue the user filled mid-flight. cur keeps
    // only what arrived under the native key: usage tails and settle records.
    const bySession = {
      ...s.bySession,
      [newKey]: {
        ...cur,
        ...prev,
        draftLaunching: undefined,
        messages,
        usage: cur?.usage ?? prev.usage,
        nativeTasks: cur?.nativeTasks ?? prev.nativeTasks,
        nativeTaskRunId: cur?.nativeTaskRunId ?? prev.nativeTaskRunId,
        nativeTaskSeq: cur?.nativeTaskSeq ?? prev.nativeTaskSeq,
        nativeActivity: cur?.nativeActivity ?? prev.nativeActivity,
        turnUsage: cur?.turnUsage ?? prev.turnUsage,
        throughput: ownsPlaceholder && throughput?.runId !== event.runId ? startThroughput(event.runId) : throughput,
        ...(ownsPlaceholder && event.engine === "codex" ? { codexRunId: event.runId } : {}),
        settledRunIds: [
          ...new Set([
            ...(prev.settledRunIds ?? []),
            ...(cur && cur !== prev ? (cur.settledRunIds ?? []) : []),
          ]),
        ],
      },
    };
    if (fromKey !== newKey) delete bySession[fromKey];
    const drafts = { ...s.drafts };
    if (fromKey !== newKey && fromKey in drafts) {
      if (drafts[fromKey] || !(newKey in drafts)) {
        drafts[newKey] = drafts[fromKey];
      }
      delete drafts[fromKey];
    }
    const streamingByKey = moveStreamingFlag(s.streamingByKey, fromKey, newKey);
    const retryingByKey = moveRetryingFlag(s.retryingByKey, fromKey, newKey);
    return { bySession, drafts, streamingByKey, retryingByKey, openTabs, active: activeNext };
  });
  // The pinned agent followed the draft key; move it onto the native id so
  // the next send in this tab injects it again.
  migrateSelectedAgent(workspacePath, nativeId);
  migrateSidechatSessionKey(fromKey, newKey, nativeId);
  migrateComposerPredictionSessionKey(fromKey, newKey);
  // Sidebar row + tab title pick the new session up immediately instead of
  // waiting for the post-turn rescan.
  const firstUser = (deps.get().bySession[newKey]?.messages ?? []).find(
    (m) => m.role === "user",
  );
  deps.upsertSessionMeta(
    optimisticMeta(
      event.engine,
      nativeId,
      workspacePath,
      firstUser ? firstLineTitle(firstUser.text) : "",
    ),
  );
}

/** Runs whose turn already wrote ledger rows report by report. Every report
 *  is one model response, so each lands in the ledger the moment it arrives —
 *  a codex turn that chats for an hour has to show up while it runs, not when
 *  it ends — and `done` must not write the same tokens again. */
const liveLedgerRuns = new Set<string>();

/** Running token totals for the reply in flight, keyed by run. `usage` keeps
 *  the newest report (the context meter needs occupancy, not a sum), while
 *  the tail indicator and the settled row show this total: what the reply has
 *  spent so far. Claude reports nothing until the end, so it never appears. */
const turnUsageTotals = new Map<string, ParsedUsage>();
/** A result seals a response, while native background work still owns the run. */
const responseCompletedRuns = new Set<string>();
const responseCompleteSeqs = new Map<string, number>();
const responseAssistantSeqs = new Map<string, number>();
/** Native auto-continuations can start a new reply without a local send. */
function resumeThroughput(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const current = deps.get().bySession[key]?.throughput;
  if (responseCompletedRuns.has(event.runId) && current?.runId === event.runId && current.ended && event.seq > current.seq) {
    patchSession(deps.set, key, { throughput: startThroughput(event.runId) });
  }
}
/** Claude flushes a turn's final usage into the transcript a moment after its
 *  result line, so the occupancy re-read waits this long. */
const USAGE_REREAD_DELAY_MS = 400;
/** The pending post-result transcript re-read, one per run: repeated results
 *  coalesce and every settle path cancels it through `dropRunUsage`. */
const usageRereadTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Drop a run's usage bookkeeping (settled, interrupted, or swept). */
export function dropRunUsage(runId: string) {
  turnUsageTotals.delete(runId);
  liveLedgerRuns.delete(runId);
  responseCompletedRuns.delete(runId);
  responseCompleteSeqs.delete(runId);
  responseAssistantSeqs.delete(runId);
  const reread = usageRereadTimers.get(runId);
  if (reread !== undefined) {
    clearTimeout(reread);
    usageRereadTimers.delete(runId);
  }
}

/** A native result's usage is the response's summed billing, not the context
 *  size, and with background work the final done can trail it by hours: re-read
 *  the transcript's per-message snapshot after each result so the meter does
 *  not sit on the inflated sum until then. Skipped when the run is no longer
 *  the session's live one by the time the delay elapses. */
function scheduleUsageReread(deps: EngineEventDeps, runId: string, key: string) {
  if (!deps.refreshSessionUsage) return;
  const pending = usageRereadTimers.get(runId);
  if (pending !== undefined) clearTimeout(pending);
  usageRereadTimers.set(runId, setTimeout(() => {
    usageRereadTimers.delete(runId);
    const session = deps.get().bySession[key];
    if (
      !session ||
      session.interrupted ||
      session.nativeTaskRunId !== runId ||
      session.settledRunIds?.includes(runId) ||
      runRouting.get(runId) !== key
    ) return;
    deps.refreshSessionUsage?.(key)?.catch(() => {});
  }, USAGE_REREAD_DELAY_MS));
}

/** Route immediately, then verify silent runs against the native registry. */
export function routeAndReconcileRun(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  runId: string,
  key: string,
) {
  routeRun(runId, key);
  void reconcileOrphanRuns((ids) => ipc.activeRunIds(ids), (orphaned) => settleOrphanedRuns(set, orphaned));
}

/** Clear confirmed missing runs and their stuck state without disturbing a
 * successor already routed to the same session. */
export function settleOrphanedRuns(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  orphaned: Array<[string, string]>,
) {
  if (orphaned.length === 0) return;
  for (const [runId] of orphaned) dropRunUsage(runId);
  set((s) => {
    let streamingByKey = s.streamingByKey;
    let retryingByKey = s.retryingByKey;
    let bySession = s.bySession;
    for (const [runId, key] of orphaned) {
      const cur = bySession[key];
      // A late response must not alter a settled session or a live successor.
      if ((cur && !cur.streaming) ||
        [...runRouting].some(([id, routed]) => id !== runId && routed === key)) {
        if (cur) {
          if (bySession === s.bySession) bySession = { ...s.bySession };
          bySession[key] = { ...cur, settledRunIds: rememberSettledRun(cur, runId) };
        }
        continue;
      }
      retryingKeys.delete(key);
      streamingByKey = setStreamingFlag(streamingByKey, key, false);
      retryingByKey = setRetryingFlag(retryingByKey, key, false);
      const messages = cur ? abortAutoReviews(cur.messages) : undefined;
      if (cur) {
        if (bySession === s.bySession) bySession = { ...s.bySession };
        bySession[key] = { ...cur, messages: messages!, settledRunIds: rememberSettledRun(cur, runId), streaming: false, turnStartedAt: null, retry: null, compaction: null, handoff: null, throughput: settleThroughput(cur.throughput, undefined, true) };
      }
    }
    return { bySession, streamingByKey, retryingByKey };
  });
}

function onUsage(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const parsed = parseUsage(event.data);
  const totals = parsed ? addTurnUsage(event.runId, parsed) : null;
  // A compaction report carries only the new occupancy, so the window is
  // taken from the last snapshot that had one: the gauge must not drop to
  // the assumed 200k just because this report is narrower (see mergeUsage).
  const prev = deps.get().bySession[key]?.usage;
  patchSession(deps.set, key, {
    usage: mergeUsage(event.data, prev),
    ...(totals ? { turnUsage: usageSnapshot(totals) } : {}),
  });
  if (parsed) recordUsageReport(deps, event, key, parsed);
}

/** Fold one report into its run's running total. */
function addTurnUsage(runId: string, parsed: ParsedUsage): ParsedUsage {
  const prev = turnUsageTotals.get(runId);
  const totals: ParsedUsage = {
    input: (prev?.input ?? 0) + parsed.input,
    output: (prev?.output ?? 0) + parsed.output,
    cacheRead: (prev?.cacheRead ?? 0) + parsed.cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + parsed.cacheWrite,
    total: 0,
    ...(prev?.reasoning != null || parsed.reasoning != null
      ? { reasoning: (prev?.reasoning ?? 0) + (parsed.reasoning ?? 0) }
      : {}),
    // A later report may omit the window; the last one that reported it wins.
    contextWindow: parsed.contextWindow ?? prev?.contextWindow,
  };
  const componentSum = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  totals.total = componentSum > 0 ? componentSum : (prev?.total ?? 0) + parsed.total;
  turnUsageTotals.set(runId, totals);
  return totals;
}

/** 【Codex上下文隔离】会话级 usage 仅保存上下文占用，剥离单回合吞吐统计以免污染后续回合。 */
function stripTurnThroughput(usage: unknown): unknown {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const raw = usage as Record<string, unknown>;
  if (!("turn_throughput" in raw)) return usage;
  const rest = { ...raw };
  delete rest.turn_throughput;
  return rest;
}

/** 【Codex回合吞吐提取】仅接受与当前 run/回合严格匹配、已进入 complete 终态且无排除原因的 Codex 吞吐样本。 */
function settledCodexTurnThroughput(
  event: ChatEngineEvent,
  before: ThroughputState | null | undefined,
  settled: ThroughputState | null | undefined,
  interrupted: boolean,
  responseAlreadyComplete: boolean,
  rawDoneUsage: Record<string, unknown> | null,
): { output_tokens: number; elapsed_ms: number } | null {
  if (event.engine !== "codex" || interrupted || responseAlreadyComplete) return null;
  if (before) {
    if (before.runId !== event.runId || before.ended || before.seq >= event.seq) return null;
    const sample = settled?.sample;
    if (
      !sample ||
      sample.source !== "codex_app_server" ||
      sample.status !== "complete" ||
      sample.turnReason != null ||
      typeof sample.outputTokens !== "number" ||
      !Number.isSafeInteger(sample.outputTokens) ||
      sample.outputTokens < 0 ||
      typeof sample.elapsedMs !== "number" ||
      !Number.isFinite(sample.elapsedMs) ||
      sample.elapsedMs <= 0
    ) {
      return null;
    }
    return { output_tokens: sample.outputTokens, elapsed_ms: sample.elapsedMs };
  }
  const candidate = rawDoneUsage?.turn_throughput;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const rec = candidate as Record<string, unknown>;
  const outputTokens = rec.output_tokens ?? rec.outputTokens;
  const elapsedMs = rec.elapsed_ms ?? rec.elapsedMs;
  if (
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    typeof elapsedMs !== "number" ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    return null;
  }
  return { output_tokens: outputTokens, elapsed_ms: elapsedMs };
}

/** Keep response scope and terminal status on the message, separately from
 *  context occupancy and billing. Codex paired statistics stay response-local. */
function usageForTurnRow(
  usage: unknown,
  codexTurnThroughput?: { output_tokens: number; elapsed_ms: number } | null,
  engine?: string,
  hasTurnTotals = false,
  partial = false,
): unknown {
  const turnStatus = partial ? "partial" : "complete";
  const isCodexLastRequest = engine === "codex" && !hasTurnTotals;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    if (codexTurnThroughput) {
      return {
        usage_scope: "last_request",
        turn_throughput: codexTurnThroughput,
        turn_status: turnStatus,
      };
    }
    // No counters means no summary rate to suppress. Keep absent usage absent.
    return usage;
  }
  const raw = usage as Record<string, unknown>;
  const stripContext = raw.context_usage_kind === "current_context";
  const stripOldThroughput = "turn_throughput" in raw && !codexTurnThroughput;
  const needsLastRequestScope =
    isCodexLastRequest &&
    raw.usage_scope !== "turn" &&
    raw.usage_scope !== "unknown" &&
    raw.usage_scope !== "last_request";
  const needsTurnScope = engine === "claude" && raw.usage_scope === undefined;
  if (!stripContext && !stripOldThroughput && !needsLastRequestScope && !needsTurnScope
    && !codexTurnThroughput && raw.turn_status === turnStatus) {
    return usage;
  }
  const rest: Record<string, unknown> = { ...raw, turn_status: turnStatus };
  if (stripContext) {
    delete rest.context_usage_kind;
    delete rest.context_usage;
  }
  delete rest.turn_throughput;
  if (needsLastRequestScope) {
    rest.usage_scope = "last_request";
  } else if (needsTurnScope) {
    // Unlike transcript assistant records, Claude's result is a turn total.
    rest.usage_scope = "turn";
  }
  if (codexTurnThroughput) {
    rest.turn_throughput = codexTurnThroughput;
  }
  return rest;
}

/** Engine-shaped snapshot of a running total: parseUsage reads it back, and
 *  every consumer downstream (strip, row, breakdown) stays engine-agnostic. */
function usageSnapshot(totals: ParsedUsage): Record<string, number> {
  return {
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read_input_tokens: totals.cacheRead,
    cache_creation_input_tokens: totals.cacheWrite,
    ...(totals.reasoning != null ? { reasoning_output_tokens: totals.reasoning } : {}),
    ...(totals.input + totals.output + totals.cacheRead + totals.cacheWrite === 0 && totals.total > 0
      ? { total_tokens: totals.total }
      : {}),
    ...(totals.contextWindow ? { model_context_window: totals.contextWindow } : {}),
  };
}

/** Ledger one engine report (one request) as it arrives. */
function recordUsageReport(
  deps: EngineEventDeps,
  event: ChatEngineEvent,
  key: string,
  parsed: ParsedUsage,
) {
  if (!usageTrackingEnabled()) return;
  liveLedgerRuns.add(event.runId);
  writeUsageRow(deps, event, key, parsed, 1);
}

/** Shared writer: one ledger row for the run's model and session. */
function writeUsageRow(
  deps: EngineEventDeps,
  event: ChatEngineEvent,
  key: string,
  parsed: ParsedUsage,
  reports: number,
) {
  if (parsed.input + parsed.output + parsed.cacheRead + parsed.cacheWrite === 0) {
    return;
  }
  const state = deps.get();
  const tab = state.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  void ipc
    .usageRecord({
      ts: Date.now(),
      engine: event.engine,
      model: stampedModel(deps, event.engine, key),
      sessionId: event.sessionId ?? tab?.sessionId ?? null,
      workspacePath: tab?.workspacePath ?? state.active?.workspacePath ?? null,
      input: parsed.input,
      output: parsed.output,
      cacheRead: parsed.cacheRead,
      cacheWrite: parsed.cacheWrite,
      reports,
      durationMs: null,
    })
    .catch(() => {});
}

function onError(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  clearRetry(key, deps);
  // A round cannot outlive its turn: the CLI's question died with it.
  askLoops.delete(key);
  if (deps.get().bySession[key]?.compaction) patchSession(deps.set, key, { compaction: null });
  // Fold unflushed chunks into rows and settle them: the turn stops here,
  // and the scheduled flush must not write them in after the fact.
  const prev = deps.get().bySession[key] ?? EMPTY_SESSION;
  const pending = drainPending(key);
  // Ending a Desktop follow does not release its task. Leave queued messages
  // for an explicit user action until they have checked the external backend.
  const desktopUnconfirmed = event.engine === "codex" && desktopTaskMayContinue(event.data);
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    let messages = settleLiveRows(
      pending
        ? applyStreamParts(
            cur.messages,
            pending.parts,
            pending.model ?? flushModel(deps, event.engine, key),
            pending.effort ?? stampedEffort(deps, event.engine, key),
          )
        : cur.messages,
    );
    messages = abortAutoReviews(messages);
    const durationMs = cur.turnStartedAt
      ? Math.max(0, Date.now() - cur.turnStartedAt)
      : null;
    if (durationMs != null && !responseCompletedRuns.has(event.runId)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          if (messages[i].steer) continue;
          break;
        }
        if (messages[i].role === "assistant") {
          messages = [
            ...messages.slice(0, i),
            { ...messages[i], durationMs },
            ...messages.slice(i + 1),
          ];
          break;
        }
      }
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages,
          error: event.data as string,
          streaming: false,
          turnStartedAt: null,
          turnUsage: null,
          throughput: settleThroughput(cur.throughput, event.runId, true, event.seq),
          handoff: null,
          nativeActivity: null,
          followUpAt: null,
          queueParked: desktopUnconfirmed,
          interruptRequestedAt: null,
          lastInterruptAt: null,
          settledRunIds: rememberSettledRun(cur, event.runId),
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
      retryingByKey: setRetryingFlag(s.retryingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry and usage bookkeeping so the
  // maps cannot grow forever.
  runRouting.delete(event.runId);
  untrackRun(event.runId);
  dropRunUsage(event.runId);
  // Failed turns can still create a transcript; index it just as onDone does.
  ipc.rescanSessions().catch(() => {});
  deps.markUnseenIfBackground(key);
  void deps.refreshSessionUsage?.(key).catch(() => {});
  // An error settles the turn exactly like done does — the messages typed
  // behind it are the user's next step, and parking them here left the queue
  // stuck until it was sent or cleared by hand. A stop is still the user's
  // own call: that queue stays parked (a kill via `interrupted`, an interrupt
  // that left the run alive via `queueParked`).
  if (!prev.interrupted && !prev.queueParked && !desktopUnconfirmed) deps.drainQueue(key);
}

/** Patch the grant state of one card row, located by its message seq. */
export function patchGrantBySeq(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  seq: number,
  patch: (grant: NonNullable<Message["grant"]>) => NonNullable<Message["grant"]>,
) {
  set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let changed = false;
    const messages = cur.messages.map((m) => {
      if (m.seq !== seq || m.role !== "grant" || !m.grant) return m;
      changed = true;
      return { ...m, grant: patch(m.grant) };
    });
    if (!changed) return {};
    return { bySession: { ...s.bySession, [key]: { ...cur, messages } } };
  });
}

/** RPC request ids may restart at zero for every process. Match the owning
 * run as well, including settled events and asynchronous answer receipts. */
export function patchQuestionByRequestId(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  runId: string,
  requestId: string,
  patch: (question: NonNullable<Message["question"]>) => NonNullable<Message["question"]>,
) {
  set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let changed = false;
    const messages = cur.messages.map((m) => {
      if (m.role !== "question" || m.question?.runId !== runId || m.question.requestId !== requestId) return m;
      changed = true;
      return { ...m, question: patch(m.question) };
    });
    if (!changed) return {};
    return { bySession: { ...s.bySession, [key]: { ...cur, messages } } };
  });
}

/** Patch a question card by its row seq: a multi-select round keeps one card
 * across the fresh request ids the CLI re-asks it with. */
export function patchQuestionBySeq(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  seq: number,
  patch: (question: NonNullable<Message["question"]>) => NonNullable<Message["question"]>,
) {
  set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let changed = false;
    const messages = cur.messages.map((m) => {
      if (m.seq !== seq || m.role !== "question" || !m.question) return m;
      changed = true;
      return { ...m, question: patch(m.question) };
    });
    if (!changed) return {};
    return { bySession: { ...s.bySession, [key]: { ...cur, messages } } };
  });
}

/** A permission denial arrives mid-turn (tool_result) and again in the
 * final result's permission_denials; one card per denied path. The card is
 * the actionable surface: grant → next launch gets --add-dir. */
function onPermissionDenied(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const data = event.data as {
    tool?: string | null;
    path?: string | null;
    message?: string;
  };
  const path = data.path?.trim() || null;
  const message = (data.message ?? "").trim();
  // Fold unflushed chunks first so the card lands after the streamed text.
  const pending = drainPending(key);
  let rowSeq = -1;
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    const base = pending
      ? applyStreamParts(
          cur.messages,
          pending.parts,
          pending.model ?? flushModel(deps, event.engine, key),
        )
      : cur.messages;
    const messages = settleLiveRows(base);
    const dup = messages.some(
      (m) =>
        m.role === "grant" &&
        (path ? m.path === path : m.text === message) &&
        m.grant?.status !== "declined",
    );
    if (dup) return {};
    const seq = messages.length ? messages[messages.length - 1].seq + 1 : 1;
    rowSeq = seq;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages: [
            ...messages,
            {
              role: "grant",
              text: message,
              path,
              ts: new Date().toISOString(),
              seq,
              grant: { status: "pending" as const },
            },
          ],
        },
      },
    };
  });
  // Preview the directory a grant would cover; failure is non-fatal — the
  // backend re-resolves inside grant_root.
  if (path && rowSeq > 0) {
    void ipc
      .grantScope(path)
      .then((dir) =>
        patchGrantBySeq(deps.set, key, rowSeq, (grant) => ({ ...grant, dir })),
      )
      .catch(() => {});
  }
}

/** End a multi-select round through the CLI's free-form row: the only answer
 * that both stops the re-ask loop and reaches the formatted result. */
let pendingQuestionWrites = 0;
function deliverQuestionAnswer(runId: string, requestId: string, answers: Record<string, string>, key: string, deps: EngineEventDeps) {
  pendingQuestionWrites++;
  void ipc
    .answerQuestion(runId, requestId, answers)
    .catch((error) => patchSession(deps.set, key, { error: errorText(error) }))
    .finally(() => { pendingQuestionWrites--; });
}
function sendAskTerminator(loop: AskLoop, key: string, deps: EngineEventDeps) {
  deliverQuestionAnswer(loop.runId, loop.requestId, { [loop.base]: ASK_OTHER_OPTION }, key, deps);
}

function onQuestion(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const data = event.data as {
    requestId?: string;
    toolUseId?: string | null;
    input?: { questions?: QuestionSpec[]; extui?: { method?: string }; codexApproval?: NonNullable<Message["question"]>["codexApproval"] };
  };
  const requestId = data.requestId?.trim();
  const questions = data.input?.questions;
  if (!requestId || !Array.isArray(questions) || questions.length === 0) return;
  const method = data.input?.extui?.method;
  // The CLI's free-form editor, opened by a multi-select submit: the picked
  // labels travel as its text, so it must not surface as another card.
  const editing = method === "editor" || method === "input" ? takeAskEditor(key, event.runId) : undefined;
  if (editing) {
    deliverQuestionAnswer(editing.runId, requestId, { [editing.base]: editing.text }, key, deps);
    return;
  }
  const spec = questions[0];
  if (!spec) return;
  const frame = parseAskFrame(spec.question, spec.options ?? []);
  // An rpc select frame carries no checkbox state: its question is multi-select
  // when the ask tool declared it so, or once the CLI reports a selection.
  const rpc = method === "select";
  // The CLI re-asks a multi-select question with a fresh request id after every
  // answer, so those frames resume the card the round already owns.
  const loop = askLoops.get(key);
  if (loop && loop.runId === event.runId && loop.base === frame.base) {
    if (loop.phase === "sent") {
      // It re-asked because the editor answer was lost: re-arm and re-send.
      loop.requestId = requestId;
      sendAskTerminator(loop, key, deps);
      return;
    }
    patchQuestionBySeq(deps.set, key, loop.seq, (question) => ({
      ...question,
      requestId,
      // Same shape as a fresh card: the CLI's runtime rows are not options.
      questions: rpc && questions.length === 1
        ? [{ ...spec, multiSelect: true, options: frame.options }]
        : questions,
      ...(question.status === "pending" ? {} : { status: "pending" as const }),
    }));
    return;
  }
  const multi = rpc
    ? frame.selectedCount !== null ||
      declaredMulti(deps.get().bySession[key]?.messages ?? [], frame)
    : spec.multiSelect === true;
  // Fold unflushed chunks first so the card lands after the streamed text.
  const pending = drainPending(key);
  let rowSeq = -1;
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    const base = pending
      ? applyStreamParts(
          cur.messages,
          pending.parts,
          pending.model ?? flushModel(deps, event.engine, key),
        )
      : cur.messages;
    const messages = settleLiveRows(base);
    // A replayed frame (initialize re-arm) must not double-render the card.
    const dup = messages.some(
      (m) => m.role === "question" && m.question?.runId === event.runId && m.question.requestId === requestId,
    );
    if (dup) return {};
    const seq = messages.length ? messages[messages.length - 1].seq + 1 : 1;
    rowSeq = seq;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages: [
            ...messages,
            {
              role: "question",
              text: questions[0]?.question ?? "",
              ts: new Date().toISOString(),
              seq,
              question: {
                requestId,
                runId: event.runId,
                toolUseId: data.toolUseId ?? null,
                codexApproval: data.input?.codexApproval,
                // The CLI's runtime rows (free-form Other, done) are not the
                // question's options: the card answers through the round.
                questions:
                  rpc && questions.length === 1
                    ? [{ ...spec, multiSelect: multi, options: frame.options }]
                    : questions,
                status: "pending" as const,
              },
            },
          ],
        },
      },
    };
  });
  if (rowSeq > 0 && rpc && multi) {
    openAskLoop(key, { base: frame.base, seq: rowSeq, requestId, runId: event.runId });
  }
}

/** Fold unflushed stream chunks into settled rows, then run a plan-card
 *  transform, so a plan card lands after the text streamed before it (the
 *  same fold the question/grant cards do). */
function updatePlanMessages(
  deps: EngineEventDeps,
  key: string,
  event: ChatEngineEvent,
  transform: (messages: Message[]) => Message[] | null,
) {
  const pending = drainPending(key);
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    const base = pending
      ? applyStreamParts(
          cur.messages,
          pending.parts,
          pending.model ?? flushModel(deps, event.engine, key),
        )
      : cur.messages;
    const next = transform(settleLiveRows(base));
    if (!next) return {};
    return { bySession: { ...s.bySession, [key]: { ...cur, messages: next } } };
  });
}

const PLAN_STATUSES: readonly PlanReviewStatus[] = [
  "draft",
  "awaiting_review",
  "submitting",
  "approved",
  "changes_requested",
  "deferred",
  "cancelled",
  "expired",
  "superseded",
];

function onPlanDraft(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const data = (event.data ?? {}) as {
    planId?: unknown;
    text?: unknown;
    replace?: unknown;
  };
  const planId = typeof data.planId === "string" ? data.planId.trim() : "";
  const text = typeof data.text === "string" ? data.text : "";
  if (!planId) return;
  updatePlanMessages(deps, key, event, (messages) =>
    applyPlanDraft(messages, {
      planId,
      text,
      replace: data.replace === true,
      engine: event.engine,
      sessionId: event.sessionId,
      runId: event.runId,
      ts: event.ts ?? Date.now(),
    }),
  );
}

function onPlanReview(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const record = event.data as PlanReview | null | undefined;
  // Fail closed on a malformed record: a card without identity/revision
  // could never be CAS-arbitrated, so it must not reach the timeline.
  if (
    !record ||
    typeof record.planId !== "string" ||
    !record.planId.trim() ||
    typeof record.revision !== "number" ||
    !PLAN_STATUSES.includes(record.status)
  ) {
    return;
  }
  updatePlanMessages(deps, key, event, (messages) =>
    applyPlanReview(messages, record),
  );
}

function onPlanReviewSettled(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const data = (event.data ?? {}) as {
    planId?: unknown;
    revision?: unknown;
    status?: unknown;
  };
  const planId = typeof data.planId === "string" ? data.planId.trim() : "";
  const revision = typeof data.revision === "number" ? data.revision : -1;
  const status = data.status as PlanReviewStatus;
  if (!planId || revision < 0 || !PLAN_STATUSES.includes(status)) return;
  updatePlanMessages(deps, key, event, (messages) =>
    applyPlanSettled(messages, planId, revision, status),
  );
}

function onQuestionSettled(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const data = event.data as { requestId?: string; answers?: Record<string, string | string[]> };
  const requestId = data?.requestId?.trim();
  if (!requestId) return;
  patchQuestionByRequestId(deps.set, key, event.runId, requestId, (question) => {
    if (question.codexApproval && ["allow_once", "decline"].includes(String(data.answers?.decision))) {
      return { ...question, status: "answered", answers: data.answers, submitting: false, error: undefined };
    }
    return question.status === "pending" ? { ...question, status: "cancelled", submitting: false } : question;
  });
  // A settled frame ends its round: whatever the CLI was waiting on is gone.
  const loop = askLoops.get(key);
  if (loop?.runId === event.runId && loop.requestId === requestId) askLoops.delete(key);
}

function onWarn(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  // Non-terminal notice (e.g. an upstream 429 the CLI is retrying): show the
  // banner, but the turn is still alive — streaming state, unflushed chunks,
  // and run routing all stay untouched. Cleared by onDone when the turn
  // recovers, overwritten by onError if it ends up failing.
  patchSession(deps.set, key, { error: event.data as string });
}

/**
 * Live provider-retry progress (claude `system/api_retry`, codex
 * `Reconnecting... n/m`, omp `auto_retry_start`). Shown in the run status
 * line as "重试中 x/y" — deliberately NOT the error banner: the CLI is
 * backing off and will re-issue the request, so this is progress. An attempt
 * of 0 (or a retry-end event) clears it; so does the next content event.
 */
function onRetry(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const data = (event.data ?? {}) as {
    attempt?: unknown;
    max?: unknown;
    message?: unknown;
  };
  const attempt = typeof data.attempt === "number" ? data.attempt : 0;
  if (attempt <= 0) {
    clearRetry(key, deps);
    return;
  }
  retryingKeys.add(key);
  if (!deps.get().retryingByKey[key]) {
    deps.set((s) => ({ retryingByKey: setRetryingFlag(s.retryingByKey, key, true) }));
  }
  patchSession(deps.set, key, {
    retry: {
      attempt,
      max: typeof data.max === "number" ? data.max : 0,
      message: typeof data.message === "string" ? data.message : "",
    },
  });
}

/** Drop the indicator once the re-issued request produces content. A
 *  recovered retry ends with output, so this lands before any explicit end
 *  event and the chip never lingers over a healthy stream. */
function clearRetry(key: string, deps: EngineEventDeps) {
  retryingKeys.delete(key);
  const state = deps.get();
  if (state.bySession[key]?.retry) patchSession(deps.set, key, { retry: null });
  if (state.retryingByKey[key]) {
    deps.set((s) => ({ retryingByKey: setRetryingFlag(s.retryingByKey, key, false) }));
  }
}

/** Engine-reported compaction progress (omp rpc-ui `auto_compaction_*`):
 *  automatic mid-turn summarization, surfaced as the tail indicator's label
 *  swap. `active: false` clears only an automatic flag — a manual compact
 *  turn owns its flag until the turn settles. */
function onCompaction(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const data = (event.data ?? {}) as { active?: unknown };
  if (data.active === true) {
    if (deps.get().bySession[key]?.compaction) return;
    patchSession(deps.set, key, {
      compaction: { automatic: true, startedAt: Date.now() },
    });
  } else if (deps.get().bySession[key]?.compaction?.automatic) {
    patchSession(deps.set, key, { compaction: null });
  }
}

const HANDOFF_STAGES = new Set<HandoffState["stage"]>(["delivering", "waiting", "running", "approval", "input"]);

/** The turn runs in Codex Desktop, which holds the thread: the tail shows
 *  the stage and rows carry Desktop's settings until the turn settles. */
function onHandoff(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const data = (event.data ?? {}) as { stage?: unknown; model?: unknown; effort?: unknown };
  const stage = HANDOFF_STAGES.has(data.stage as HandoffState["stage"])
    ? (data.stage as HandoffState["stage"])
    : "running";
  patchSession(deps.set, key, {
    handoff: {
      stage,
      model: typeof data.model === "string" && data.model ? data.model : null,
      effort: typeof data.effort === "string" && data.effort ? data.effort : null,
    },
  });
}

function onTasks(event: ChatEngineEvent, key: string, deps: EngineEventDeps) {
  const current = deps.get().bySession[key];
  if (current?.nativeTaskRunId !== event.runId || event.seq <= (current.nativeTaskSeq ?? -1)) return;
  const incoming = readNativeTasks(event.data);
  if (incoming) {
    const tasks = mergeNativeTaskSnapshot(current.nativeTasks, incoming);
    setNativeBackgroundActive(event.runId, current.nativeActivity === "requires_action" || tasks.some((task) => task.status === "running" && !task.ambient));
    patchSession(deps.set, key, { nativeTasks: tasks, nativeTaskSeq: event.seq });
  }
}

function onDone(event: ChatEngineEvent, key: string, deps: EngineEventDeps, responseOnly = false) {
  if (responseOnly && event.seq <= (responseCompleteSeqs.get(event.runId) ?? -1)) return;
  const responseAlreadyComplete = !responseOnly && responseCompletedRuns.has(event.runId);
  const lastResponseAssistant = responseAssistantSeqs.get(event.runId);
  clearRetry(key, deps);
  if (!responseOnly) askLoops.delete(key);
  if (deps.get().bySession[key]?.compaction) patchSession(deps.set, key, { compaction: null });
  const prev = deps.get().bySession[key] ?? EMPTY_SESSION;
  // done and turn_complete share this payload; an interrupted turn_complete
  // (native Esc) seals the response like any other and the run lives on.
  const data = event.data as TurnCompletePayload;
  // Occupancy for the context meter: the newest single report (claude's one
  // payload already carries the turn's totals).
  const turnTotals = turnUsageTotals.get(event.runId);
  // Zero (or no) usage is "nothing measured", not a reply that cost nothing: the
  // real CLI reports zero for an interrupted response. It must neither replace
  // the meter's occupancy nor be stamped on a row as the reply's cost.
  const rawDoneUsage =
    data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)
      ? (data.usage as Record<string, unknown>)
      : null;
  const cleanDoneUsage = stripTurnThroughput(data.usage);
  const tokensReported = turnTotals !== undefined || parseUsage(cleanDoneUsage) !== null;
  const contextReported =
    rawDoneUsage?.context_usage != null || reportedContextWindow(cleanDoneUsage) !== undefined;
  let settledUsage = tokensReported
    ? mergeUsage(turnTotals ? stripTurnThroughput(prev.usage) : cleanDoneUsage, stripTurnThroughput(prev.usage))
    : contextReported
      ? mergeUsage(cleanDoneUsage, stripTurnThroughput(prev.usage))
      : stripTurnThroughput(prev.usage ?? null);
  const finalWindow = reportedContextWindow(cleanDoneUsage);
  if (finalWindow && settledUsage && typeof settledUsage === "object") {
    settledUsage = { ...settledUsage, model_context_window: finalWindow };
  }
  // The row tells the reader what the reply cost: every report of this run
  // summed, which for a multi-request reply is more than its last request.
  turnUsageTotals.delete(event.runId);
  const finalUsage = turnTotals
    ? mergeUsage(usageSnapshot(turnTotals), settledUsage)
    : settledUsage;
  // What the ledger may count: only tokens this turn reported, never the
  // occupancy carried over from an earlier reply.
  const ledgerUsage = tokensReported ? finalUsage : null;
  // Fold the turn's last unflushed chunks (the final sink batch can arrive
  // in the same frame as done), then settle every live row: the streamed
  // text the user watched arrive *is* the final message.
  const pending = drainPending(key);
  let stampedAssistantSeq: number | undefined;
  let settledMessages = prev.messages;
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    let messages = pending
      ? applyStreamParts(
          cur.messages,
          pending.parts,
          pending.model ?? flushModel(deps, event.engine, key),
          pending.effort ?? stampedEffort(deps, event.engine, key),
        )
      : cur.messages;
    messages = settleLiveRows(messages);
    messages = abortAutoReviews(messages);
    const turnStart = cur.turnStartedAt ?? prev.turnStartedAt;
    const durationMs = turnStart ? Math.max(0, Date.now() - turnStart) : null;
    const model = stampedModel(deps, event.engine, key);
    const effort = stampedEffort(deps, event.engine, key);
    const interrupted = Boolean(data.interrupted || cur.interrupted);
    const settledThroughput = settleThroughput(cur.throughput, event.runId, interrupted, event.seq);
    // AGY can report interruption in native telemetry without a Done flag.
    // Only this response's observation may mark its summary incomplete.
    const partial = interrupted || Boolean(cur.throughput?.runId === event.runId
      && !cur.throughput.ended && cur.throughput.seq < event.seq
      && cur.throughput.sample?.status === "partial");
    const codexTurnThroughput = settledCodexTurnThroughput(
      event,
      cur.throughput,
      settledThroughput,
      partial,
      responseAlreadyComplete,
      rawDoneUsage,
    );
    const rowUsage = usageForTurnRow(
      tokensReported ? finalUsage : null,
      codexTurnThroughput,
      event.engine,
      turnTotals !== undefined,
      partial,
    );
    // Stamp usage, durationMs, effort, and model onto the turn's last assistant message.
    for (let i = responseAlreadyComplete ? -1 : messages.length - 1; i >= 0; i--) {
      // The user's message starts the turn: an assistant row before it is an
      // older reply, not this response's (a response with only thinking or tool
      // calls has no row of its own to carry the metadata).
      if (messages[i].role === "user") {
        if (messages[i].steer) continue;
        break;
      }
      if (messages[i].role === "assistant") {
        // A background result can have usage without new assistant text.
        // Its metadata must not rewrite the already sealed parent response.
        if (lastResponseAssistant !== undefined && messages[i].seq <= lastResponseAssistant) break;
        stampedAssistantSeq = messages[i].seq;
        messages = [
          ...messages.slice(0, i),
          {
            ...messages[i],
            ...(rowUsage ? { usage: rowUsage } : {}),
            ...(durationMs != null ? { durationMs } : {}),
            ...(effort ? { effort } : model && encodedModelEffort(event.engine, model) ? { effort: null } : {}),
            ...(model ? { model } : {}),
          },
          ...messages.slice(i + 1),
        ];
        break;
      }
    }
    settledMessages = messages;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages,
          error: null,
          streaming: responseOnly ? cur.streaming : false,
          turnStartedAt: responseOnly ? cur.turnStartedAt : null,
          usage: settledUsage,
          turnUsage: null,
          throughput: settledThroughput,
          interrupted: responseOnly ? cur.interrupted : false,
          handoff: responseOnly ? cur.handoff : null,
          nativeActivity: responseOnly ? cur.nativeActivity : null,
          // The CLI ended a response: a pending follow-up reached it and the
          // interrupt (if any) took effect. A final done also ends the park.
          followUpAt: null,
          interruptRequestedAt: null,
          // The acknowledgement must not clear it (a Stop right behind the
          // first would then kill the tasks the first one kept); the run's
          // final done does.
          lastInterruptAt: responseOnly ? cur.lastInterruptAt : null,
          queueParked: responseOnly ? cur.queueParked : false,
          settledRunIds: responseOnly ? cur.settledRunIds : rememberSettledRun(cur, event.runId),
        },
      },
      streamingByKey: responseOnly ? s.streamingByKey : setStreamingFlag(s.streamingByKey, key, false),
      retryingByKey: responseOnly ? s.retryingByKey : setRetryingFlag(s.retryingByKey, key, false),
    };
  });
  const interruptedTurn = Boolean(data.interrupted || prev.interrupted || prev.queueParked);
  const hasPendingInteractiveCard = settledMessages.some(
    (m) =>
      m.question?.status === "pending" ||
      m.grant?.status === "pending" ||
      ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""),
  );
  if (
    !interruptedTurn &&
    prev.queue.length === 0 &&
    !hasPendingInteractiveCard
  ) {
    requestComposerPrediction(key, settledMessages, () => {
      const latest = deps.get().bySession[key];
      return Boolean(
        latest &&
          (!latest.streaming ||
            latest.nativeActivity === "waiting" ||
            !latest.messages.some((m) => m.live)) &&
          !latest.draftLaunching &&
          !latest.interrupted &&
          latest.queue.length === 0 &&
          !latest.messages.some(
            (m) =>
              m.question?.status === "pending" ||
              m.grant?.status === "pending" ||
              ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""),
          ),
      );
    });
  }
  if (responseOnly) {
    if (data.usage != null) recordTurnUsage(deps, event, key, ledgerUsage);
    responseCompletedRuns.add(event.runId);
    responseCompleteSeqs.set(event.runId, event.seq);
    if (stampedAssistantSeq !== undefined) responseAssistantSeqs.set(event.runId, stampedAssistantSeq);
    // The final done can be far away (background wait, auto-continuations), so
    // the meter's occupancy correction cannot wait for it. A stopped session
    // is re-read by the stop path itself.
    if (event.engine === "claude" && !prev.interrupted) scheduleUsageReread(deps, event.runId, key);
    return;
  }
  // The run is over: drop its routing entry so the map cannot grow forever.
  runRouting.delete(event.runId);
  untrackRun(event.runId);
  // Ledger the turn's tokens now that it is settled: the same report that
  // stamps the row above, so the usage page counts real engine numbers. The
  // feature's own switch gates it (localStorage-backed, see usage-tracking.ts).
  if (!responseAlreadyComplete) recordTurnUsage(deps, event, key, ledgerUsage);
  dropRunUsage(event.runId);
  // Native file changed; refresh list cache in background.
  void ipc.rescanSessions().catch(() => {});
  deps.markUnseenIfBackground(key);
  // An interrupted turn settles here too: keep the queue parked — the user
  // stopped the session, the next message is theirs to send.
  if (!prev.interrupted && !prev.queueParked) {
    deps.drainQueue(key);
    // Claude's result line reports the turn's summed usage (every request of
    // the turn added up), not the occupancy the meter shows — so re-read the
    // latest per-message snapshot from the session file once the engine has
    // settled it. AGY's SQLite gen_metadata and /compact turns need the same
    // post-turn re-read.
    const lastUser = [...prev.messages].reverse().find((m) => m.role === "user");
    const compactTurn = Boolean(lastUser?.text.trim().startsWith("/compact"));
    if (event.engine === "claude" || event.engine === "agy" || compactTurn) {
      setTimeout(() => {
        deps.refreshSessionUsage?.(key)?.catch(() => {});
      }, USAGE_REREAD_DELAY_MS);
    }
  }
}

/** Ledger the turn's own report when it never reported live (claude sends one
 *  usage payload, the turn's totals, on its result line). Turns that streamed
 *  reports already have their rows. */
function recordTurnUsage(
  deps: EngineEventDeps,
  event: ChatEngineEvent,
  key: string,
  usage: unknown,
) {
  if (!usageTrackingEnabled()) return;
  if (liveLedgerRuns.delete(event.runId)) return;
  const parsed = parseUsage(usage);
  if (!parsed) return;
  writeUsageRow(deps, event, key, parsed, 1);
}

/** Mark a session running off an event of a turn this client never sent: the
 *  phone watching the desktop's run, or the desktop watching the phone's.
 *  Routes the run first so Stop and the orphan sweep reach it, then lifts the
 *  two flags the composer / sidebar / tab dots read. */
function adoptObservedRun(
  event: ChatEngineEvent,
  key: string,
  deps: EngineEventDeps,
) {
  const cur = deps.get().bySession[key];
  if (!cur && event.sessionId && key === sessionKey(event.engine, event.sessionId, "")) {
    const state = deps.get();
    const pending = state.openTabs.filter((tab) => tab.engine === event.engine && tab.sessionId === null)
      .map((tab) => {
        const pendingKey = sessionKey(tab.engine, null, tab.workspacePath);
        const session = state.bySession[pendingKey];
        const localRunId = localSessionRun(session);
        return session?.streaming && localRunId && runRouting.get(localRunId) === pendingKey
          ? { nativeKey: key, pendingKey, localRunId } : undefined;
      }).filter((candidate) => candidate !== undefined);
    if (pending.length === 1) {
      pendingSessionOrigins.set(event.runId, pending[0]);
      if (pendingSessionOrigins.size > MAX_PENDING_SESSION_ORIGINS) {
        pendingSessionOrigins.delete(pendingSessionOrigins.keys().next().value!);
      }
    }
  }
  // Ordinary content/tool batches must not allocate telemetry or add a store
  // write. The first actual sample creates it; only clear an existing old run.
  if (cur?.throughput && cur.throughput.runId !== event.runId) {
    patchSession(deps.set, key, { throughput: startThroughput(event.runId) });
  }
  if (event.engine === "codex" && cur?.codexRunId && cur.codexRunId !== event.runId) {
    // An observed transport takeover cannot inherit the old run's ability to
    // steer, even when an old route still exists under this session.
    patchSession(deps.set, key, { codexRunId: undefined, liveLaunch: undefined });
  }
  if (event.engine === "claude" && cur?.nativeTaskRunId !== event.runId) {
    if (cur?.nativeTaskRunId) {
      // The superseded run must not remain an orphan whose later sweep could
      // clear the newer run's streaming flag under the same session key.
      runRouting.delete(cur.nativeTaskRunId);
      untrackRun(cur.nativeTaskRunId);
      dropRunUsage(cur.nativeTaskRunId);
    }
    patchSession(deps.set, key, beginNativeRun(cur ?? EMPTY_SESSION, event.runId));
  }
  if (!runRouting.has(event.runId)) {
    routeAndReconcileRun(deps.set, event.runId, key);
  }
  if (!cur?.streaming) {
    clearComposerPrediction(key);
    patchSession(deps.set, key, {
      streaming: true,
      turnStartedAt: cur?.turnStartedAt ?? Date.now(),
    });
  }
  if (!deps.get().streamingByKey[key]) {
    deps.set((s) => ({
      streamingByKey: setStreamingFlag(s.streamingByKey, key, true),
    }));
  }
}

// Retain terminal run identities after routing is removed. A delayed retry
// can otherwise fall back to sessionId and masquerade as a new observed run.
// Bound this history; real new turns always carry a fresh runId.
// Exported like runRouting so tests can reset it — reusing one runId across
// tests would otherwise leak the previous test's terminal state.
export const settledRuns = new Map<string, "done" | "error">();
const MAX_SETTLED_RUNS = 256;

/** Only serializable bookkeeping crosses a renderer lifetime. Outstanding usage
 * rereads are a readiness blocker; timer closures are never serialized. */
export function captureEngineEventRuntime() {
  return {
    throughputEventSeqs: [...throughputEventSeqs], retryingKeys: [...retryingKeys],
    pendingSessionModels: [...pendingSessionModels], pendingSessionEfforts: [...pendingSessionEfforts],
    pendingSessionProviders: [...pendingSessionProviders], liveLedgerRuns: [...liveLedgerRuns],
    turnUsageTotals: [...turnUsageTotals], responseCompletedRuns: [...responseCompletedRuns],
    responseCompleteSeqs: [...responseCompleteSeqs], responseAssistantSeqs: [...responseAssistantSeqs],
    settledRuns: [...settledRuns],
    pendingSessionOrigins: [...pendingSessionOrigins],
  };
}

export function engineEventCheckpointBlockers(): string[] {
  return [
    ...(usageRereadTimers.size ? ["usage-reread-pending"] : []),
    ...(pendingQuestionWrites ? ["question-control-write-pending"] : []),
  ];
}

export function restoreEngineEventRuntime(snapshot: ReturnType<typeof captureEngineEventRuntime>): void {
  const restoreMap = <K, V>(target: Map<K, V>, values: Array<[K, V]>) => { target.clear(); for (const [key, value] of values) target.set(key, value); };
  const restoreSet = <T>(target: Set<T>, values: T[]) => { target.clear(); for (const value of values) target.add(value); };
  for (const timer of usageRereadTimers.values()) clearTimeout(timer);
  usageRereadTimers.clear();
  restoreMap(throughputEventSeqs, snapshot.throughputEventSeqs);
  restoreSet(retryingKeys, snapshot.retryingKeys);
  restoreMap(pendingSessionModels, snapshot.pendingSessionModels);
  restoreMap(pendingSessionEfforts, snapshot.pendingSessionEfforts);
  restoreMap(pendingSessionProviders, snapshot.pendingSessionProviders);
  restoreSet(liveLedgerRuns, snapshot.liveLedgerRuns);
  restoreMap(turnUsageTotals, snapshot.turnUsageTotals);
  restoreSet(responseCompletedRuns, snapshot.responseCompletedRuns);
  restoreMap(responseCompleteSeqs, snapshot.responseCompleteSeqs);
  restoreMap(responseAssistantSeqs, snapshot.responseAssistantSeqs);
  restoreMap(settledRuns, snapshot.settledRuns);
  restoreMap(pendingSessionOrigins, (snapshot.pendingSessionOrigins ?? []).slice(-MAX_PENDING_SESSION_ORIGINS));
}

/** Resolve an event's session key (run routing, then session-id match) and
 * dispatch to the per-kind handler. */
function adoptLeaderSession(event: ChatEngineEvent, nativeId: string | null, deps: EngineEventDeps) {
  if (!event.leader || !nativeId) return;
  const key = sessionKey(event.engine, nativeId, event.leader.workspacePath);
  rememberLeaderSession(key);
  const existing = deps.get().bySession[key];
  const assignment = event.kind === "session" ? event.leader.assignment : undefined;
  const addAssignment = !!assignment && claimLeaderAssignment(key);
  if (!existing) markLeaderSession(key);
  if (!existing || addAssignment) {
    deps.set((s) => {
      const current = s.bySession[key] ?? { ...EMPTY_SESSION, messages: [] };
      const messages = addAssignment && !current.messages.some((m) => m.role === "user")
        ? [{ seq: 0, role: "user", text: assignment!, ts: null }, ...current.messages] : current.messages;
      return { bySession: { ...s.bySession, [key]: { ...current, messages } } };
    });
  }
  if (!deps.get().sessions.some((s) => s.engine === event.engine && s.sessionId === nativeId)) {
    deps.upsertSessionMeta(optimisticMeta(event.engine, nativeId, event.leader.workspacePath, event.leader.title));
  }
  if (event.kind === "delta" && typeof event.data === "string" && event.data) {
    emitLeaderStreamDelta(event.leader.branchId, event.data);
  }
  routeAndReconcileRun(deps.set, event.runId, key);
}

export function handleEngineEvents(
  events: ChatEngineEvent[],
  deps: EngineEventDeps,
) {
  let toolBatch: { event: ChatEngineEvent; key: string; tools: ToolMessageInput[] } | undefined;
  const flushTools = () => {
    if (!toolBatch) return;
    const { event, key, tools } = toolBatch;
    toolBatch = undefined;
    appendToolMessages(deps.set, key, tools, stampedModel(deps, event.engine, key));
  };
  for (const event of events) {
    if (isSideRunEvent(event)) {
      handleSideRunEvent(event);
      continue;
    }
    if (Number.isSafeInteger(event.seq)) {
      const seq = Math.max(throughputEventSeqs.get(event.runId) ?? -1, event.seq);
      throughputEventSeqs.delete(event.runId);
      throughputEventSeqs.set(event.runId, seq);
      if (throughputEventSeqs.size > 256) throughputEventSeqs.delete(throughputEventSeqs.keys().next().value!);
    }
    // These are host-stamped identities, not an engine's requested draft.
    // They remain independent even when two children start before a snapshot.
    if (event.leader?.reclaimed || event.leader?.identityRejected) continue;
    const managedId = event.sessionId ?? (event.kind === "session" && typeof event.data === "string" ? event.data : null);
    if (event.leader && (!managedId || !leaderEventAllowed(event.leader.branchId, sessionKey(event.engine, managedId, event.leader.workspacePath)))) continue;
    const data = event.kind === "message"
      ? event.data as ToolMessageInput & { role: string }
      : undefined;
    const isTool = data?.role === "tool" || data?.role === "tool_result";
    if (toolBatch && (
      !isTool ||
      event.runId !== toolBatch.event.runId ||
      event.engine !== toolBatch.event.engine ||
      event.sessionId !== toolBatch.event.sessionId
    )) {
      flushTools();
    }
    const settled = settledRuns.get(event.runId);
    // Plans outlive their run's terminal event: expire_parked_plans settles
    // parked approvals after done/error at teardown (either order for a
    // kill), so plan events must reach the switch even then.
    const isPlanEvent =
      event.kind === "plan_draft" ||
      event.kind === "plan_review" ||
      event.kind === "plan_review_settled";
    // EOF stderr/failure can follow Done, and the turn's final usage report
    // can trail either terminal event. Keep those, but never adopt the run
    // again or drain its queue a second time.
    if (
      settled &&
      !(
        event.kind === "tasks" ||
        event.kind === "usage" ||
        event.kind === "throughput" ||
        event.kind === "plan_review_settled" ||
        (settled === "done" &&
          (event.kind === "warn" ||
            event.kind === "error" ||
            event.kind === "question_settled" ||
            // A next_turn review can arrive after its plan turn's done.
            event.kind === "plan_draft" ||
            event.kind === "plan_review"))
      )
    )
      continue;
    if (!settled) adoptLeaderSession(event, managedId, deps);
    const state = deps.get();
    let key = runRouting.get(event.runId) ?? Object.keys(state.bySession).find(
      (candidate) => state.bySession[candidate]?.settledRunIds?.includes(event.runId),
    );
    if (key) touchRun(event.runId);
    if (!key && event.kind === "auto_review" && event.sessionId) {
      const exactKey = sessionKey(event.engine, event.sessionId, "");
      if (exactKey in state.bySession) key = exactKey;
    }
    if (!key && event.kind !== "auto_review" && event.sessionId) {
      key = sessionKey(event.engine, event.sessionId, "");
      // sessionId-only key lacks workspace; find active match
      if (!(key in state.bySession)) {
        const match = Object.keys(state.bySession).find(
          (k) => k === key || k.endsWith(`/${event.sessionId}`),
        );
        if (match) key = match;
      }
    }
    if (!key) continue;
    if (isReclaimedLeaderSession(key)) continue;
    const session = state.bySession[key];
    if (event.kind === "auto_review") {
      const data = readAutoReview(event.data);
      if (!data || typeof data.threadId !== "string" || data.threadId !== event.sessionId || key !== sessionKey(event.engine, data.threadId, "") || settled || session?.interrupted || session?.settledRunIds?.includes(event.runId)) continue;
      updatePlanMessages(deps, key, event, (messages) => upsertAutoReview(messages, data));
      continue;
    }
    if (event.kind === "throughput") {
      onThroughput(event, key, deps);
      continue;
    }
    const retiredRun = event.engine === "claude" && !!session?.retiredNativeRunIds?.includes(event.runId);
    const stoppedRun = event.engine === "claude" && !!session?.interrupted && session.nativeTaskRunId === event.runId;
    // Card bookkeeping outlives its run: the reader teardown settles parked
    // questions/plans under the killed run's id (before its terminal done), so
    // these must still reach their cards after a Stop or a takeover by a newer
    // run. They are cleanup, not activity: never adopt the dead run again.
    const outlivesRun = isPlanEvent || event.kind === "question_settled";
    const runEnded = retiredRun || stoppedRun || !!session?.settledRunIds?.includes(event.runId);
    // Native catalogs keep their owning run identity after routing is dropped.
    // A delayed snapshot from a retired run cannot replace a newer catalog.
    if (!outlivesRun && retiredRun) continue;
    if (event.kind === "tasks" && (settled || state.bySession[key]?.settledRunIds?.includes(event.runId))) {
      onTasks(event, key, deps);
      continue;
    }
    if (stoppedRun && !outlivesRun && event.kind !== "done" && event.kind !== "error") {
      if (event.kind === "tasks") onTasks(event, key, deps);
      continue;
    }
    if (event.kind === "done" || event.kind === "error") {
      pendingSessionOrigins.delete(event.runId);
      settledRuns.set(event.runId, event.kind);
      if (settledRuns.size > MAX_SETTLED_RUNS) {
        settledRuns.delete(settledRuns.keys().next().value!);
      }
      // Every turn funnels through here: drop the computer-use global
      // Esc-to-stop so a system-wide hotkey never outlives its run. Arming
      // is per computer-use send (messaging.ts); the call is idempotent.
      void ipc.computerUseSetActive?.(false)?.catch(() => {});
    }
    if (!outlivesRun &&
      state.bySession[key]?.settledRunIds?.includes(event.runId)) {
      // A usage report trailing the terminal event carries the turn's final
      // occupancy. Re-read it from the transcript instead of patching the
      // settled state — the file can lag the event, and refreshSessionUsage
      // retries briefly for exactly that.
      if (event.kind === "usage") {
        void deps.refreshSessionUsage?.(key)?.catch(() => {});
      } else if (
        (event.kind === "warn" || event.kind === "error") &&
        !state.bySession[key]?.streaming
      ) {
        // Shutdown diagnostics remain visible, but cannot restart a turn or
        // overwrite a newer turn's state.
        onWarn(event, key, deps);
      }
      continue;
    }

    // Engine events reach every attached client, but the running flag is set
    // by the sender's own send path — so an observer (a phone watching the
    // desktop's turn) would never see one. The events are the shared truth:
    // adopt any run still talking, let done/error settle it below. A denial
    // is excluded on purpose: the CLI has stopped to ask, and the grant
    // card's resend has to stay available while it waits. Cleanup of an ended
    // run is no sign of life (see outlivesRun): adopting it would re-arm a
    // stopped tab or take the session back from the newer run.
    if (!settled && !(outlivesRun && runEnded) &&
      event.kind !== "done" && event.kind !== "error" && event.kind !== "permission_denied") {
      adoptObservedRun(event, key, deps);
    }

    switch (event.kind) {
      case "delta":
        onDelta(event, key, deps);
        break;
      case "thinking":
        onThinking(event, key, deps);
        break;
      case "message":
        if (isTool && data) {
          if (retryingKeys.has(key)) clearRetry(key, deps);
          resumeThroughput(event, key, deps);
          toolBatch ??= { event, key, tools: [] };
          toolBatch.tools.push({ ...data, patch: data.patch === true });
        } else {
          onMessage(event, key, deps);
        }
        break;
      case "session":
        onSession(event, key, deps);
        break;
      case "usage":
        onUsage(event, key, deps);
        break;
      case "tasks":
        onTasks(event, key, deps);
        break;
      case "activity": {
        const activity = (event.data as { state?: unknown } | null)?.state;
        if (activity === "running" || activity === "waiting" || activity === "requires_action") {
          if (activity === "running") resumeThroughput(event, key, deps);
          // One idle cycle reports `waiting` twice (after the result, after
          // idle). The first released a queued message into the CLI; the second
          // is that same cycle, not a CLI that is idle again, and must not undo
          // the optimistic "running" or release a second item. Any real work of
          // the CLI reports running/requires_action first, which lifts the guard.
          const current = deps.get().bySession[key];
          if (activity === "waiting" && followUpGuardActive(current)) {
            // A queued delivery can still be resolving its agent block while
            // the CLI itself remains idle. Its guard must not swallow the
            // waiting ACK of a Stop that cancelled that preparation.
            if (current?.nativeActivity === "waiting" && current.interruptRequestedAt != null) {
              patchSession(deps.set, key, { interruptRequestedAt: null });
            }
            break;
          }
          // Only an idle boundary confirms that an interrupted reply ended.
          // Startup can report running/requires_action after Stop was sent;
          // those events must not forget the still-pending request.
          patchSession(
            deps.set,
            key,
            activity === "waiting"
              ? { nativeActivity: activity, interruptRequestedAt: null }
              : { nativeActivity: activity, followUpAt: null },
          );
          setNativeBackgroundActive(event.runId, activity === "requires_action" || Boolean(deps.get().bySession[key]?.nativeTasks?.some((task) => task.status === "running" && !task.ambient)));
          // The CLI idles with background tasks still running: the next queued
          // message goes straight in, as the native CLI would take it.
          if (activity === "waiting") deps.drainQueueLive?.(key);
        }
        break;
      }
      case "turn_complete":
        onDone(event, key, deps, true);
        break;
      case "error":
        if (settled === "done") onWarn(event, key, deps);
        else onError(event, key, deps);
        break;
      case "warn":
        onWarn(event, key, deps);
        break;
      case "retry":
        onRetry(event, key, deps);
        break;
      case "compaction":
        onCompaction(event, key, deps);
        break;
      case "handoff":
        onHandoff(event, key, deps);
        break;
      case "permission_denied":
        onPermissionDenied(event, key, deps);
        break;
      case "question":
        onQuestion(event, key, deps);
        break;
      case "question_settled":
        onQuestionSettled(event, key, deps);
        break;
      case "plan_draft":
        onPlanDraft(event, key, deps);
        break;
      case "plan_review":
        onPlanReview(event, key, deps);
        break;
      case "plan_review_settled":
        onPlanReviewSettled(event, key, deps);
        break;
      case "done":
        onDone(event, key, deps);
        break;
      case "model":
        onModel(event, key, deps);
        break;
      case "effort":
        onEffort(event, key, deps);
        break;
    }
  }
  flushTools();
}
