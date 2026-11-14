import i18n from "@/lib/i18n";
import { crossSessionParticipantKey, useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "./cross-session";
import type { CrossSessionCostReview } from "./cross-session-cost";
import { useHandoffStore } from "./session-cleanup";
import { sessionKey, useChatStore } from "./store";

export function canPrepareCrossSessionHandoff(record: CrossSessionCommunicationRecord, review = record.costReview): boolean {
  // A reference window is uncertain cache evidence, not a reason to prevent
  // the user from explicitly preparing a handoff for a held request.
  return !record.target.sessionId.startsWith("leader-branch:") &&
    review?.targetStatus !== "busy" && review?.targetStatus !== "awaiting_permission";
}

/** Prepare a draft only. The held request remains untouched until separately
 * approved or cancelled; the new chat does not acquire task ownership. */
export function prepareCrossSessionHandoff(record: CrossSessionCommunicationRecord, review?: CrossSessionCostReview): void {
  const current = useCrossSessionActivityStore.getState().records.find(item => item.scopedId === record.scopedId);
  if (!current || current.status !== "awaiting_cost_approval" || current.requestId !== record.requestId ||
    current.leaderCostApproval?.requestId !== record.leaderCostApproval?.requestId ||
    crossSessionParticipantKey(current.target) !== crossSessionParticipantKey(record.target) ||
    crossSessionParticipantKey(current.sender) !== crossSessionParticipantKey(record.sender)) {
    throw new Error(i18n.t("crossSession.costHandoffStale"));
  }
  if (!canPrepareCrossSessionHandoff(current, review ?? current.costReview)) throw new Error(i18n.t("crossSession.costHandoffUnavailable"));
  const target = current.target;
  if (useHandoffStore.getState().byWorkspace[target.workspacePath]) throw new Error(i18n.t("crossSession.costHandoffBusy"));
  const state = useChatStore.getState();
  const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
  const sourceState = state.bySession?.[key];
  if (sourceState?.streaming || sourceState?.draftLaunching || sourceState?.queue.length) throw new Error(i18n.t("crossSession.costHandoffUnavailable"));
  const meta = state.sessions.find(item => item.engine === target.engine && item.sessionId === target.sessionId && item.workspacePath === target.workspacePath);
  useHandoffStore.getState().startHandoff({
    workspacePath: target.workspacePath, sourceEngine: target.engine, sourceSessionId: target.sessionId,
    sourceTitle: meta?.customTitle || meta?.title || target.title || target.sessionId.slice(0, 8),
    sourceMeta: meta, sourceState, nextTask: current.message, archiveSourceOnSend: false, initialMode: "local",
  });
}
