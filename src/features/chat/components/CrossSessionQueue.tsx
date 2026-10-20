import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { MessageQueue } from "@/components/application/ai-chat/message-queue";
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

  return (
    <MessageQueue
      queue={queue}
      title={t("crossSession.queueTitle")}
      onSendNow={handleSendNow}
      sendNowLabel={t("crossSession.sendNow")}
      sendNowTitle={t("crossSession.sendNowTooltip")}
      onRemove={handleRemove}
      className={className}
    />
  );
}
