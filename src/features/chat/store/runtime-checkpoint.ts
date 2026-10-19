import { cloneCheckpointValue, registerRuntimeCheckpointParticipant, type RuntimeCheckpointParticipant } from "@/lib/runtime-checkpoint";
import type { ChatStore } from "./types";
import { askLoops, type AskLoop } from "./ask-loop";
import { captureEngineEventRuntime, restoreEngineEventRuntime, engineEventCheckpointBlockers } from "./engine-events";
import { captureStreamRuntime, restoreStreamRuntime, flushPendingStreams, type StreamRuntimeCheckpoint } from "./stream";

const STATE_KEYS = [
  "workspaces", "sessions", "archivedSessionKeys", "engines", "active", "openTabs", "activeEngine", "permission",
  "efforts", "defaultClaudeUltracode", "ompServiceTier", "codexServiceTier", "models", "providers", "threadLimit",
  "workspaceGroups", "workspaceAliases", "archivedWorkspaces", "sendShortcut", "thinkingAutoCollapse",
  "bySession", "streamingByKey", "retryingByKey", "unseen", "drafts", "pendingMention", "actionError",
] as const satisfies readonly (keyof ChatStore)[];
type ChatData = Pick<ChatStore, (typeof STATE_KEYS)[number]>;
interface ChatCheckpoint {
  version: 1;
  state: ChatData;
  stream: StreamRuntimeCheckpoint;
  events: ReturnType<typeof captureEngineEventRuntime>;
  asks: Array<[string, AskLoop]>;
}

const restored = new WeakSet<() => ChatStore>();
export const hasRestoredChatCheckpoint = (get: () => ChatStore): boolean => restored.has(get);

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function parseCheckpoint(value: unknown): ChatCheckpoint {
  const candidate = cloneCheckpointValue(value);
  if (!object(candidate) || candidate.version !== 1 || !object(candidate.state) || !object(candidate.stream) || !object(candidate.events) || !Array.isArray(candidate.asks)) {
    throw new Error("Invalid chat runtime checkpoint");
  }
  const state = candidate.state;
  if (!STATE_KEYS.every((key) => key in state) || !object(state.bySession) || !object(state.drafts) || !Array.isArray(state.openTabs) || !Array.isArray(state.sessions) || !Array.isArray(state.workspaces)) {
    throw new Error("Incomplete chat runtime checkpoint");
  }
  for (const session of Object.values(state.bySession)) {
    if (!object(session) || !Array.isArray(session.messages) || !Array.isArray(session.queue) || typeof session.streaming !== "boolean" || typeof session.loading !== "boolean") {
      throw new Error("Invalid checkpoint session");
    }
  }
  for (const key of ["routes", "activity", "pending"]) if (!Array.isArray(candidate.stream[key])) throw new Error("Invalid checkpoint stream");
  for (const key of Object.keys(captureEngineEventRuntime())) {
    // Older renderers did not record provisional-to-native placeholder origins.
    if (key === "pendingSessionOrigins" && !(key in candidate.events)) continue;
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
      return cloneCheckpointValue({ version: 1, state, stream: captureStreamRuntime(), events: captureEngineEventRuntime(), asks: [...askLoops] });
    },
    restore(value) {
      const snapshot = parseCheckpoint(value);
      // Select only data keys. A malformed checkpoint cannot replace actions.
      const data = Object.fromEntries(STATE_KEYS.map((key) => [key, snapshot.state[key]])) as ChatData;
      restoreStreamRuntime(snapshot.stream);
      restoreEngineEventRuntime(snapshot.events);
      askLoops.clear(); for (const [key, loop] of snapshot.asks) askLoops.set(key, loop);
      restored.add(get);
      store.setState({ ...data, initialized: false });
      flushPendingStreams(store.setState);
    },
    resumed,
  };
}

export function registerChatCheckpoint(store: ChatCheckpointStore, get: () => ChatStore, resumed: () => void): () => void {
  return registerRuntimeCheckpointParticipant(createChatCheckpointParticipant(store, get, resumed));
}
