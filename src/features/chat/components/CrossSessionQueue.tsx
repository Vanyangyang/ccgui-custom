import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { MessageQueue } from "@/components/application/ai-chat/message-queue";
import { CrossSessionCostApproval } from "./CrossSessionCostApproval";
import { useChatStore, sessionKey, type ActiveSession, type QueuedMessage } from "../store";
import {
  cancelCrossSessionMessage,
  crossSessionParticipantKey,
  sendCrossSessionMessageNow,
  useCrossSessionActivityStore,
} from "../cross-session";

/** Messages from other chats still waiting for this one. They live in the
 *  host chat bridge, not the composer queue, so they get their own card with
 *  the same "send now" / remove controls. */
export function CrossSessionQueue({ active, className }: { active: ActiveSession | null; className?: string }) {
  const { t } = useTranslation();
  const setSessionError = useChatStore((s) => s.setSessionError);
  const participantKey = active?.sessionId
    ? crossSessionParticipantKey({ engine: active.engine, sessionId: active.sessionId, workspacePath: active.workspacePath })
    : undefined;
  const records = useCrossSessionActivityStore(useShallow((state) => participantKey
    ? state.records.filter((record) => (record.status === "queued" || record.status === "received") &&
      crossSessionParticipantKey(record.target) === participantKey)
    : []));
  const approvals = useCrossSessionActivityStore(useShallow((state) => participantKey
    ? state.records.filter((record) => record.status === "awaiting_cost_approval" &&
      [record.sender, record.target].some((side) => crossSessionParticipantKey(side) === participantKey))
    : []));
  const sessions = useChatStore((s) => s.sessions);
  // The activity store lists newest first; the bridge sends oldest first.
  const queue = useMemo<QueuedMessage[]>(() => [...records].reverse().map((record) => ({
    id: record.scopedId,
    text: t("crossSession.queuedFrom", {
      title: record.sender.title || `${record.sender.engine} ${record.sender.sessionId.slice(0, 8)}`,
      message: record.message,
    }),
    images: [],
    queuedAt: record.acceptedAt,
  })), [records, t]);
  const key = active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  const report = useCallback((error: unknown) => {
    if (key) setSessionError(key, t("crossSession.queueActionFailed", { error: error instanceof Error ? error.message : String(error) }));
  }, [key, setSessionError, t]);
  const handleSendNow = useCallback((id: string) => { sendCrossSessionMessageNow(id).catch(report); }, [report]);
  const handleRemove = useCallback((id: string) => { cancelCrossSessionMessage(id).catch(report); }, [report]);

  return <>
    {approvals.length > 0 && <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
    {approvals.map((record) => <section key={record.scopedId} className={className} data-testid="cross-session-approval-queue">
      <div className="flex flex-col gap-2 rounded-xl border border-border-secondary bg-background-secondary-default p-2">
        <p className="text-caption-1-medium text-text-primary [overflow-wrap:anywhere]">
          {[record.sender, record.target].map((side) => {
            const meta = sessions.find((s) => s.engine === side.engine && s.sessionId === side.sessionId && s.workspacePath === side.workspacePath);
            return meta?.customTitle || meta?.title || side.title || `${side.engine} · ${side.sessionId.slice(0, 8)}`;
          }).join(" → ")}
        </p>
        <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-caption-1-regular text-text-secondary [overflow-wrap:anywhere]">{record.message}</p>
        <CrossSessionCostApproval record={record} />
      </div>
    </section>)}
    </div>}
    <MessageQueue
      queue={queue}
      title={t("crossSession.queueTitle")}
      onSendNow={handleSendNow}
      sendNowLabel={t("crossSession.sendNow")}
      sendNowTitle={t("crossSession.sendNowTooltip")}
      onRemove={handleRemove}
      className={className}
    />
  </>;
}
