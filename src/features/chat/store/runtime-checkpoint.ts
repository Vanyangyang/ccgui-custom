import { cloneCheckpointValue, registerRuntimeCheckpointParticipant, type RuntimeCheckpointParticipant } from "@/lib/runtime-checkpoint";
import { clearComposerPrediction, reconcileComposerPrediction } from "../composer-prediction";
import type { ChatStore } from "./types";
import { askLoops, type AskLoop } from "./ask-loop";
import { captureEngineEventRuntime, restoreEngineEventRuntime, engineEventCheckpointBlockers } from "./engine-events";
import { captureStreamRuntime, restoreStreamRuntime, flushPendingStreams, type StreamRuntimeCheckpoint } from "./stream";
import { sessionKey } from "./persistence";
import { hostPendingKey } from "./host-pending-chat";
import { hasReadableUsage } from "../usage";
import { hasReloadableHistory, markReloadableHistory } from "./session-memory-cache";

const STATE_KEYS = [
  "workspaces", "sessions", "archivedSessionKeys", "engines", "active", "openTabs", "activeEngine", "permission",
  "efforts", "defaultClaudeUltracode", "ompServiceTier", "codexServiceTier", "models", "providers", "threadLimit",
  "workspaceGroups", "workspaceAliases", "archivedWorkspaces", "sendShortcut", "thinkingAutoCollapse",
  "bySession", "streamingByKey", "retryingByKey", "unseen", "drafts", "pendingMention", "actionError",
] as const satisfies readonly (keyof ChatStore)[];
type ChatData = Pick<ChatStore, (typeof STATE_KEYS)[number]>;
interface ChatCheckpoint {
  version: 1;
  /** Distinguishes caches captured after historical-source discovery was fixed. */
  archiveSourcesVersion?: 1;
  /** Distinguishes caches captured after AGY session/load post-response replay drain was fixed. */
  agyLoadDrainVersion?: 1;
  state: ChatData;
  stream: StreamRuntimeCheckpoint;
  events: ReturnType<typeof captureEngineEventRuntime>;
  asks: Array<[string, AskLoop]>;
  /** Only exact history-backed arrays carry reloadability across a renderer. */
  reloadableSessionKeys?: string[];
}

const restored = new WeakSet<() => ChatStore>();
export const hasRestoredChatCheckpoint = (get: () => ChatStore): boolean => restored.has(get);

/** Idle sessions whose restored usage the context gauge cannot read.
 *  A checkpoint carries the previous renderer's usage verbatim, and a session
 *  that already has messages never re-reads its history, so a snapshot the
 *  previous backend mis-parsed (Claude's all-zero `<synthetic>` error notice)
 *  would keep the gauge on "unknown" until the next turn — even after the
 *  update that fixed the parser. These keys get one usage re-read on resume. */
export function unreadableUsageKeys(state: Pick<ChatStore, "bySession" | "openTabs">): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const check = (key: string) => {
    if (!key || key.startsWith("new:") || seen.has(key)) return;
    seen.add(key);
    const session = state.bySession[key];
    if (!session || session.streaming || session.messages.length === 0) return;
    if (hasReadableUsage(session.usage)) return;
    keys.push(key);
  };
  for (const tab of state.openTabs) {
    if (tab.sessionId) check(sessionKey(tab.engine, tab.sessionId, tab.workspacePath));
  }
  for (const key of Object.keys(state.bySession)) check(key);
  return keys;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function parseCheckpoint(value: unknown): ChatCheckpoint {
  const candidate = cloneCheckpointValue(value);
  if (!object(candidate) || candidate.version !== 1 || !object(candidate.state) || !object(candidate.stream) || !object(candidate.events) || !Array.isArray(candidate.asks)) {
    throw new Error("Invalid chat runtime checkpoint");
  }
  const state = candidate.state;
  if (candidate.agyLoadDrainVersion !== undefined && candidate.agyLoadDrainVersion !== 1) {
    throw new Error("Invalid AGY load drain checkpoint version");
  }
  if (candidate.reloadableSessionKeys !== undefined && (!Array.isArray(candidate.reloadableSessionKeys) ||
    candidate.reloadableSessionKeys.some(key => typeof key !== "string"))) throw new Error("Invalid reloadable session evidence");
  if (!STATE_KEYS.every((key) => key in state) || !object(state.bySession) || !object(state.drafts) || !Array.isArray(state.openTabs) || !Array.isArray(state.sessions) || !Array.isArray(state.workspaces)) {
    throw new Error("Incomplete chat runtime checkpoint");
  }
  for (const [key, session] of Object.entries(state.bySession)) {
    if (!object(session) || !Array.isArray(session.messages) || !Array.isArray(session.queue) || typeof session.streaming !== "boolean" || typeof session.loading !== "boolean") {
      throw new Error("Invalid checkpoint session");
    }
    if (
      session.failedTurn !== undefined &&
      session.failedTurn !== null &&
      (!object(session.failedTurn) ||
        typeof session.failedTurn.userSeq !== "number" ||
        typeof session.failedTurn.error !== "string")
    ) {
      throw new Error("Invalid checkpoint session");
    }
    if (session.hostTaskOrigin !== undefined) {
      const origin = session.hostTaskOrigin;
      if (!object(origin) || !["engine", "runId", "workspacePath"].every(field =>
        typeof origin[field] === "string" && (origin[field] as string).length > 0 && !(origin[field] as string).includes("\0")) ||
        origin.sessionId !== undefined && (typeof origin.sessionId !== "string" || !origin.sessionId || /[\s\u0000-\u001f]/.test(origin.sessionId)) ||
        key !== (origin.sessionId ? sessionKey(origin.engine as string, origin.sessionId as string, origin.workspacePath as string)
          : hostPendingKey(origin.engine as string, origin.runId as string))) throw new Error("Invalid host task checkpoint identity");
    }
  }
  for (const key of ["routes", "activity", "pending"]) if (!Array.isArray(candidate.stream[key])) throw new Error("Invalid checkpoint stream");
  for (const key of Object.keys(captureEngineEventRuntime())) {
    // Older renderers omitted placeholder origins and per-run outcome evidence.
    // Restore those absent additions as empty; a present malformed value still fails.
    if ((key === "pendingSessionOrigins" || key === "settledRunOutcomes") && !(key in candidate.events)) continue;
    if (!Array.isArray(candidate.events[key])) throw new Error("Incomplete checkpoint event bookkeeping");
  }
  return candidate as unknown as ChatCheckpoint;
}

export interface ChatCheckpointStore {
  getState(): ChatStore;
  setState(patch: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)): void;
}

export function createChatCheckpointParticipant(store: ChatCheckpointStore, get: () => ChatStore, resumed: () => void): RuntimeCheckpointParticipant {
  return {
    id: "chat",
    readiness() {
      const state = store.getState();
      const blockers = engineEventCheckpointBlockers();
      if (!state.initialized && !restored.has(get)) blockers.push("not-initialized");
      for (const [key, session] of Object.entries(state.bySession)) {
        if (session.loading || session.draftLaunching) blockers.push(`session-preparing:${key}`);
        if (session.messages.some((row) => row.question?.submitting || row.planReview?.status === "submitting")) blockers.push(`approval-submitting:${key}`);
      }
      if ([...askLoops.values()].some((loop) => loop.phase === "sent")) blockers.push("question-editor-handoff-pending");
      return blockers;
    },
    ready: () => store.getState().init(),
    capture(): ChatCheckpoint {
      flushPendingStreams(store.setState);
      const state = Object.fromEntries(STATE_KEYS.map((key) => [key, store.getState()[key]])) as ChatData;
      const reloadableSessionKeys = Object.keys(state.bySession).filter(key => hasReloadableHistory(state.bySession[key]));
      return cloneCheckpointValue({ version: 1, archiveSourcesVersion: 1, agyLoadDrainVersion: 1, state, stream: captureStreamRuntime(), events: captureEngineEventRuntime(), asks: [...askLoops], reloadableSessionKeys });
    },
    restore(value) {
      const snapshot = parseCheckpoint(value);
      // Select only data keys. A malformed checkpoint cannot replace actions.
      const data = Object.fromEntries(STATE_KEYS.map((key) => [key, snapshot.state[key]])) as ChatData;
      for (const [key, session] of Object.entries(data.bySession)) {
        const sourceMessages = session.messages;
        // Legacy tool rows have neither their original event identity nor time.
        // Never guess where they belong; AGY's native history owns the saved
        // text. Keep the cache intact until the normal guarded read succeeds.
        if (snapshot.archiveSourcesVersion !== 1 && key.startsWith("agy/") && session.messages.some((m) => m.role === "tool")) {
          session.historyReloadRequired = true;
        }
        // Pre-drain AGY sessions resumed across a compaction checkpoint could append
        // prior turns' thoughts/text under a newly sent prompt while SQLite stayed clean.
        if (snapshot.agyLoadDrainVersion !== 1 && key.startsWith("agy/") && session.messages.some((m) => m.role !== "user")) {
          session.historyReloadRequired = true;
        }
        if (session.messages.some((m) => m.model === "<synthetic>")) {
          session.messages = session.messages.map((m) =>
            m.model === "<synthetic>" ? { ...m, model: undefined, usage: undefined } : m,
          );
        }
        // Old Claude checkpoints do not distinguish live turn totals from
        // single-request history. Preserve counts without claiming completeness.
        const codex = key.startsWith("codex/") || key.startsWith("new:codex:");
        const claude = key.startsWith("claude/") || key.startsWith("new:claude:");
        if (codex || claude) {
          if (
            session.messages.some(
              (m) =>
                m.usage &&
                typeof m.usage === "object" &&
                !Array.isArray(m.usage) &&
                !("usage_scope" in (m.usage as Record<string, unknown>)),
            )
          ) {
            session.messages = session.messages.map((m) =>
              m.usage &&
              typeof m.usage === "object" &&
              !Array.isArray(m.usage) &&
              !("usage_scope" in (m.usage as Record<string, unknown>))
                ? { ...m, usage: { ...(m.usage as Record<string, unknown>), usage_scope: codex ? "last_request" : "unknown" } }
                : m,
            );
          }
        }
        if (session.activeModel === "<synthetic>") session.activeModel = null;
        if (!session.historyReloadRequired && session.messages === sourceMessages && snapshot.reloadableSessionKeys?.includes(key)) {
          markReloadableHistory(session.messages, session.subagentHistory);
        }
      }
      restoreStreamRuntime(snapshot.stream);
      restoreEngineEventRuntime(snapshot.events);
      askLoops.clear(); for (const [key, loop] of snapshot.asks) askLoops.set(key, loop);
      restored.add(get);
      store.setState({ ...data, initialized: false });
      flushPendingStreams(store.setState);
      for (const [key, session] of Object.entries(store.getState().bySession)) {
        if (session.streaming || session.draftLaunching || session.interrupted || session.error || session.queue.length) {
          clearComposerPrediction(key, { resetTurn: true });
        } else if (!session.loading && !session.historyReloadRequired) {
          reconcileComposerPrediction(key, session.messages);
        }
      }
    },
    resumed,
  };
}

export function registerChatCheckpoint(store: ChatCheckpointStore, get: () => ChatStore, resumed: () => void): () => void {
  return registerRuntimeCheckpointParticipant(createChatCheckpointParticipant(store, get, resumed));
}
