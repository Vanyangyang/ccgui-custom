import { useTranslation } from "react-i18next";
import type { Message } from "@/lib/ipc";
import { useChatStore } from "../store";
import { useScopedSessionKey } from "../split/session-scope";

export function CodexApprovalCard({ message, record = false }: { message: Message; record?: boolean }) {
  const { t } = useTranslation();
  const key = useScopedSessionKey();
  const respond = useChatStore((s) => s.respondToQuestion);
  const question = message.question;
  const approval = question?.codexApproval;
  if (!question || !approval) return null;
  const state = question.status === "answered"
    ? question.answers?.decision === "allow_once" ? "allowed" : "declined"
    : question.status === "pending" ? "pending" : "cancelled";
  return <section aria-label={t("chat.codexApproval.title")} className="space-y-2 text-caption-1-regular text-text-secondary">
    <div className="text-body-medium text-text-primary">{t("chat.codexApproval.title")} · {t(`chat.codexApproval.status.${state}`)}</div>
    {approval.reason && <p className="whitespace-pre-wrap break-words">{approval.reason}</p>}
    <details open={!record}>
      <summary className="cursor-pointer">{t("chat.autoReview.action")}: {t(`chat.codexApproval.kind.${approval.kind}`)}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(approval.details, null, 2)}</pre>
    </details>
    {approval.grantScope === "turn" && <p>{t("chat.codexApproval.turnScope")}</p>}
    {question.error && <p role="alert" className="text-text-error-primary">{question.error}</p>}
    {!record && question.status === "pending" && <div className="flex gap-2">
      <button type="button" disabled={!key || question.submitting} onClick={() => key && void respond(key, message.seq, { decision: "decline" })} className="rounded-lg border border-border-secondary px-3 py-2 disabled:opacity-50">{t("chat.codexApproval.decline")}</button>
      <button type="button" disabled={!key || question.submitting || !approval.canApprove} onClick={() => key && void respond(key, message.seq, { decision: "allow_once" })} className="rounded-lg border border-border-secondary px-3 py-2 disabled:opacity-50">{t(approval.grantScope === "turn" ? "chat.codexApproval.allowTurn" : "chat.codexApproval.allowOnce")}</button>
    </div>}
    {question.submitting && <p role="status">{t("chat.codexApproval.submitting")}</p>}
  </section>;
}
