import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen } from "@tauri-apps/api/event";
import { captureRuntimeCheckpointParticipant, cloneCheckpointValue, runtimeCheckpoint, type RuntimeCheckpoint } from "./runtime-checkpoint";
import { pauseWorkerEvents, resumeWorkerEvents } from "./transport";

export interface RuntimeObserverSnapshot {
  checkpoint: RuntimeCheckpoint;
  cursors: Record<string, number>;
  observer: true;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Remote observation shares rendered native facts, never another renderer's
 * draft/queue or half-finished automatic submission workflow. */
export function sanitizeObserverCheckpoint(checkpoint: RuntimeCheckpoint, cursors: Record<string, number>): RuntimeObserverSnapshot {
  const chat = cloneCheckpointValue(checkpoint.participants.chat);
  if (checkpoint.version !== 1 || !object(chat) || chat.version !== 1 || !object(chat.state) || !object(chat.state.bySession)) {
    throw new Error("Invalid observer chat checkpoint");
  }
  const copiedCursors = cloneCheckpointValue(cursors);
  if (!object(copiedCursors) || Object.entries(copiedCursors).some(([id, cursor]) =>
    !id || !Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("Invalid observer event cursors");
  const state = chat.state;
  const sessions = chat.state.bySession;
  state.drafts = {};
  state.pendingMention = null;
  state.actionError = null;
  chat.asks = [];
  for (const session of Object.values(sessions)) {
    if (!object(session) || !Array.isArray(session.messages)) throw new Error("Invalid observer session");
    session.queue = [];
    delete session.draftLaunching;
    // These prove local launch ownership, unlike nativeTaskRunId/runRouting.
    delete session.codexRunId;
    delete session.liveLaunch;
    for (const message of session.messages) {
      if (object(message) && object(message.question)) delete message.question.submitting;
    }
  }
  return { checkpoint: { version: 1, participants: { chat } }, cursors: copiedCursors, observer: true };
}

interface Installation { disposed: boolean; unlisten?: () => void }
let installation: Installation | undefined;
// Keep one cut at a time, including across dispose/re-install boundaries.
let requests: Promise<void> = Promise.resolve();
const HISTORY_READY_TIMEOUT_MS = 10_000;
const BUSY_ERROR = "Observer snapshot is busy while chat history loads; retry shortly";
class ObserverBusyError extends Error {}

function historyLoading(chat: unknown): boolean {
  return object(chat) && object(chat.state) && object(chat.state.bySession) &&
    Object.values(chat.state.bySession).some((session) => object(session) && session.loading === true);
}

/** Installed by the ready desktop only. This bypasses public event fanout and
 * cannot send model/control commands; native authenticates the remote request. */
export async function installRuntimeObserverResponder(): Promise<() => void> {
  if (installation && !installation.disposed) throw new Error("Runtime observer responder is already installed");
  const owner: Installation = { disposed: false };
  installation = owner;
  const handle = async (requestId: string, deadline: number) => {
    let ownsPause = false;
    let snapshot: RuntimeObserverSnapshot | undefined;
    let failure: string | null = null;
    const releaseOwnedPause = async () => {
      if (ownsPause && !runtimeCheckpoint.isPaused()) {
        ownsPause = false;
        await resumeWorkerEvents();
      }
    };
    try {
      if (owner.disposed) return;
      try {
        while (!snapshot) {
          if (owner.disposed) return;
          if (runtimeCheckpoint.isPaused()) throw new Error("Runtime handoff is in progress");
          if (Date.now() >= deadline) throw new ObserverBusyError();
          // pause rejects an incomplete delivery before a mixed-state cut can exist.
          const cursors = await pauseWorkerEvents();
          ownsPause = true;
          if (owner.disposed) return;
          if (runtimeCheckpoint.isPaused()) throw new Error("Runtime handoff is in progress");
          // No await between the synchronous participant capture and cursor copy.
          const chat = captureRuntimeCheckpointParticipant("chat");
          if (historyLoading(chat)) {
            // The observer cannot inherit the desktop's history-load Promise.
            // Let the original fetch/delivery finish, then take a NEW full cut.
            await releaseOwnedPause();
            await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
            continue;
          }
          snapshot = sanitizeObserverCheckpoint({ version: 1, participants: { chat } }, cursors);
        }
      } catch (error) {
        // Do not expose conversation data or native exception strings to logs.
        failure = error instanceof ObserverBusyError ? BUSY_ERROR : "Observer checkpoint is temporarily unavailable";
      }
      if (owner.disposed) return;
      await nativeInvoke("runtime_observer_respond", { requestId, snapshot: snapshot ?? null, error: failure });
    } finally {
      // A planned handoff may have taken the pause while capture/respond waited.
      // Disposing this listener never revokes the handoff's event barrier.
      await releaseOwnedPause();
    }
  };
  try {
    owner.unlisten = await nativeListen<{ requestId?: unknown }>("runtime://observer-snapshot", ({ payload }) => {
      if (owner.disposed || !payload || typeof payload.requestId !== "string" || !payload.requestId || payload.requestId.length > 128) return;
      const requestId = payload.requestId;
      const deadline = Date.now() + HISTORY_READY_TIMEOUT_MS;
      requests = requests.catch(() => {}).then(() => handle(requestId, deadline));
      // Native response failure is not retried as a second, contradictory reply.
      // The requester times out; event transport reports its own resume failures.
      void requests.catch(() => {});
    });
  } catch (error) {
    owner.disposed = true;
    if (installation === owner) installation = undefined;
    throw error;
  }
  return () => {
    if (owner.disposed) return;
    owner.disposed = true;
    owner.unlisten?.();
    if (installation === owner) installation = undefined;
  };
}
