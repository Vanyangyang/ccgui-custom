import { create } from "zustand";
import type { HostChatSession } from "@ccgui/plugin-sdk";
import type { PromptCacheWindow, SessionMeta } from "@/lib/ipc";
import type { ChatStore } from "./store/types";
import { sessionKey } from "./store/persistence";
import { runsModel } from "./store/live-follow-up";
import { resolveSessionModel, type SessionState } from "./store/stream";
import { resolveContextMaxInfo } from "./context-window-memory";
import { hasReadableUsage, parseUsage, selectCursorContext } from "./usage";
import { readAgyReferenceWindow, selectAgyContext } from "./components/agy-context";
import { getPromptCacheHeatRatio, getSessionCacheHeat, isPromptCacheExpiringSoon, promptCacheForEngine, type CacheHeat } from "./prompt-cache";

export interface CrossSessionCostReview {
  /** Time this local snapshot was read, not the upstream usage event time. */
  capturedAt: number;
  cacheHeat: CacheHeat;
  cache?: PromptCacheWindow;
  targetStatus: HostChatSession["status"];
  model?: string;
  context: {
    used?: number;
    max?: number;
    kind: "current_context" | "last_request" | "unknown";
    capacityKnown: boolean;
    reference: boolean;
    modelMismatch: boolean;
    usageModel?: string;
  };
}

function finiteTokens(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read existing per-request/context telemetry; never infer tokens from file size
 * or session billing totals, and never launch a model to fill missing values. */
export function crossSessionCostReview(
  meta: SessionMeta,
  state: ChatStore,
  targetStatus: HostChatSession["status"],
  now = Date.now(),
): CrossSessionCostReview {
  const session = state.bySession[sessionKey(meta.engine, meta.sessionId, meta.workspacePath)];
  const tab = state.openTabs.find((t) => t.engine === meta.engine && t.sessionId === meta.sessionId && t.workspacePath === meta.workspacePath);
  const model = resolveSessionModel(tab ?? { engine: meta.engine }, session, meta.model ?? state.models?.[meta.engine]);
  const usage = session?.usage;
  // Match latestMessageUsage's source selection: a trailing empty/error report
  // must not relabel an older model's still-displayed occupancy.
  const usageMessage = session?.messages.findLast((m) => hasReadableUsage(m.usage)) ??
    session?.messages.findLast((m) => m.usage != null);
  const usageModel = usageMessage?.model ?? undefined;
  const sameLaunchedModel = !!session?.liveLaunch && !!model && !!usageModel &&
    runsModel(session.liveLaunch, model) && runsModel(session.liveLaunch, usageModel);
  const modelMismatch = !!model && !!usageModel && model !== usageModel && !sameLaunchedModel;
  const window = resolveContextMaxInfo({ engine: meta.engine, model, usage: modelMismatch ? null : usage });
  const context: CrossSessionCostReview["context"] = {
    max: window.known ? window.max : undefined,
    capacityKnown: window.known,
    kind: "unknown", reference: false, modelMismatch, usageModel,
  };
  if (meta.engine === "agy") {
    const selection = selectAgyContext(usage, readAgyReferenceWindow(), window.known ? window.max : undefined);
    context.used = finiteTokens(selection.total);
    context.reference = selection.noteKey === "chat.agyReferenceWindowNote";
    if (!modelMismatch) {
      context.max = selection.max;
      context.capacityKnown = selection.capacityKnown;
    }
    // A last-prompt sample is still not measured current occupancy, even when
    // a user reference window permits the normal gauge to show a percentage.
    const current = usage && typeof usage === "object" && "context_usage_kind" in usage &&
      usage.context_usage_kind === "current_context";
    context.kind = context.used === undefined ? "unknown" : current && !modelMismatch ? "current_context" : "last_request";
  } else if (meta.engine === "cursor") {
    const selection = selectCursorContext(usage, window.known ? window.max : undefined);
    context.used = finiteTokens(selection.used);
    if (!modelMismatch && selection.capacityKnown) {
      context.max = selection.max;
      context.capacityKnown = true;
    }
    context.kind = context.used === undefined ? "unknown" : modelMismatch ? "last_request" : "current_context";
  } else {
    context.used = finiteTokens(parseUsage(usage)?.total);
    context.kind = context.used === undefined ? "unknown" : modelMismatch ? "last_request" : "current_context";
  }
  const cache = promptCacheForEngine(meta.engine, meta.promptCache) ?? undefined;
  return { capturedAt: now, cacheHeat: getSessionCacheHeat(cache, now), cache, targetStatus, model, context };
}

/** Busy targets queue normally when cache is hot; only cold/unknown/expiring
 * cache or a model mismatch requires human cost approval. */
export function requiresCrossSessionCostApproval(review: CrossSessionCostReview): boolean {
  return review.cacheHeat !== "hot" || review.context.modelMismatch ||
    isPromptCacheExpiringSoon(getPromptCacheHeatRatio(review.cache, undefined, false, review.capturedAt));
}

export const MIN_SESSION_SEND_COST_APPROVAL_TOKENS = 50_000;
export const LARGE_UNKNOWN_CACHE_CONTEXT_TOKENS = MIN_SESSION_SEND_COST_APPROVAL_TOKENS;
export const LARGE_UNKNOWN_CACHE_IDLE_MS = 60 * 60 * 1000;

/** Daily composer send cost guard: only intercepts when measured context is at
 * least 50k tokens (< 50k passes through directly) and the recorded cache is
 * already cold, the model changed, or a non-Cursor session has been idle >= 1h
 * with unknown cache status. Expiring-soon (last 10%) is NOT intercepted. */
export function requiresSessionSendCostApproval(
  review: CrossSessionCostReview,
  meta?: SessionMeta,
  _session?: Pick<SessionState, "messages">,
  now = Date.now(),
): boolean {
  if ((review.context.used ?? 0) < MIN_SESSION_SEND_COST_APPROVAL_TOKENS) return false;
  if (review.cacheHeat === "cold") return true;
  if (review.context.modelMismatch) return true;
  if (
    review.cacheHeat === "unknown" &&
    meta &&
    meta.engine !== "cursor" &&
    typeof meta.updatedAt === "number" &&
    Number.isFinite(meta.updatedAt) &&
    now - meta.updatedAt >= LARGE_UNKNOWN_CACHE_IDLE_MS
  ) {
    return true;
  }
  return false;
}

/** Queue auto-drain cost guard: pauses automatic queue drain only if measured
 * context is >= 50k tokens and the session's cache window is already cold. */
export function requiresQueueDrainCostApproval(review: CrossSessionCostReview): boolean {
  return (review.context.used ?? 0) >= MIN_SESSION_SEND_COST_APPROVAL_TOKENS &&
    review.cacheHeat === "cold";
}

export interface PendingSessionSendCostGuard {
  sessionKey: string;
  engine: string;
  sessionId: string;
  workspacePath: string;
  prompt: string;
  images: string[];
  computerUse?: boolean;
  mode: "send" | "queue_drain";
  queuedItemId?: string;
  review: CrossSessionCostReview;
  onApproveSend?: () => void;
}

interface ApprovedCostSignature {
  model: string | null;
  cacheStartedAt: number | null;
}

interface SessionSendCostGuardState {
  bySessionKey: Record<string, PendingSessionSendCostGuard>;
  approvedByKey: Record<string, ApprovedCostSignature>;
  hold: (entry: PendingSessionSendCostGuard) => void;
  isApproved: (sessionKey: string, review: CrossSessionCostReview) => boolean;
  markApproved: (sessionKey: string, review: CrossSessionCostReview) => void;
  dismiss: (sessionKey: string) => void;
  reset: () => void;
}

export const useSessionSendCostGuardStore = create<SessionSendCostGuardState>((set, get) => ({
  bySessionKey: {},
  approvedByKey: {},
  hold: (entry) =>
    set((state) => ({
      bySessionKey: { ...state.bySessionKey, [entry.sessionKey]: entry },
    })),
  isApproved: (key, review) => {
    const approved = get().approvedByKey[key];
    if (!approved) return false;
    return approved.model === (review.model ?? null) &&
      approved.cacheStartedAt === (review.cache?.startedAt ?? null);
  },
  markApproved: (key, review) =>
    set((state) => {
      const nextPending = { ...state.bySessionKey };
      delete nextPending[key];
      return {
        bySessionKey: nextPending,
        approvedByKey: {
          ...state.approvedByKey,
          [key]: {
            model: review.model ?? null,
            cacheStartedAt: review.cache?.startedAt ?? null,
          },
        },
      };
    }),
  dismiss: (key) =>
    set((state) => {
      if (!(key in state.bySessionKey)) return state;
      const next = { ...state.bySessionKey };
      delete next[key];
      return { bySessionKey: next };
    }),
  reset: () => set({ bySessionKey: {}, approvedByKey: {} }),
}));
