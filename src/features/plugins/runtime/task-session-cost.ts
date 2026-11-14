import { crossSessionCostReview, requiresSessionSendCostApproval, sameSessionCostWorkspace, sessionCostEvidence, type CrossSessionCostReview } from "@/features/chat/cross-session-cost";
import { sessionKey } from "@/features/chat/store/persistence";
import type { ChatStore } from "@/features/chat/store/types";
import type { SessionMeta } from "@/lib/ipc";
import type { TaskSessionRef } from "./task-facade";

export interface TaskSessionCostEvaluation {
  required: boolean;
  review: CrossSessionCostReview;
  signature: string;
}

/** Canonicalize JSON telemetry so property insertion order is not an approval fact. */
function stableFacts(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return { nonFinite: String(value) };
  if (Array.isArray(value)) return value.map(stableFacts);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, stableFacts(child)]),
  );
  return value;
}

/** Local telemetry only. Null means the exact loaded owner cannot be established,
 * not that sending is cheap or approved. No composer approval state is consulted. */
export function evaluateTaskSessionCost(
  ref: TaskSessionRef, state: ChatStore, now = Date.now(),
): TaskSessionCostEvaluation | null {
  if (!ref.engine || !ref.sessionId || !ref.workspacePath || !state.initialized) return null;
  const sameId = (owner: { engine: string; sessionId: string | null }) =>
    owner.engine === ref.engine && owner.sessionId === ref.sessionId;
  const exact = (owner: { engine: string; sessionId: string | null; workspacePath: string }) =>
    sameId(owner) && sameSessionCostWorkspace(owner.workspacePath, ref.workspacePath);
  // Saved store keys omit workspace; a conflicting visible owner invalidates them.
  if (state.openTabs.some(owner => sameId(owner) && !sameSessionCostWorkspace(owner.workspacePath, ref.workspacePath)) ||
    state.sessions.some(owner => sameId(owner) && !!owner.workspacePath && !sameSessionCostWorkspace(owner.workspacePath, ref.workspacePath))) return null;
  const tab = state.openTabs.find(exact);
  const meta = state.sessions.find(owner => sameId(owner) && (!owner.workspacePath || exact(owner)));
  const key = sessionKey(ref.engine, ref.sessionId, ref.workspacePath);
  const session = state.bySession[key];
  if (!tab || !session || session.loading || state.archivedSessionKeys[key]) return null;

  // Project the proven owner's path for legacy metadata without a workspace,
  // without rewriting persisted metadata.
  const reviewMeta: SessionMeta = meta ? { ...meta, workspacePath: tab.workspacePath } : {
    ...ref, workspacePath: tab.workspacePath, filePath: "", fileSize: 0, fileMtimeMs: 0,
    title: "", preview: "", createdAt: null, updatedAt: null, messageCount: 0, pinned: false, customTitle: null,
  };
  const review = crossSessionCostReview(reviewMeta, state, "idle", now);
  // Match the composer: absent history metadata does not create a cost gate.
  // Identity uncertainty is handled above, independently of cost telemetry.
  const required = !!meta && requiresSessionSendCostApproval(review, meta, session, now);
  const { capturedAt: _capturedAt, ...facts } = review;
  const signature = JSON.stringify(stableFacts({
    ref, required, review: facts, evidence: sessionCostEvidence(review, ref.engine),
    // Keep bounded source facts even when policy currently masks them (e.g.
    // Codex legacy cache windows). Normalized review context represents usage;
    // never retain the potentially large raw usage payload or transcript text.
    source: { updatedAt: meta?.updatedAt, promptCache: meta?.promptCache, missingMetadata: !meta },
  }));
  return { required, review, signature };
}
