import { useTranslation } from "react-i18next";
import type { Message } from "@/lib/ipc";
import { readAutoReview } from "../store/auto-review";

export function AutoReviewCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const data = readAutoReview(message.args);
  if (!data) return null;
  const level = (value: string | null) => !value ? t("chat.autoReview.unknown") : ["low", "medium", "high", "critical", "unknown"].includes(value) ? t(`chat.autoReview.level.${value}`) : value;
  return <details className="rounded-xl border border-border-secondary bg-background-secondary-default px-3.5 py-2.5 text-left">
    <summary className="cursor-pointer text-caption-1-medium text-text-primary">
      {t("chat.autoReview.title")} · {t(`chat.autoReview.status.${data.review.status}`)}
    </summary>
    <div className="mt-2 space-y-2 text-caption-1-regular text-text-secondary">
      <div>{t("chat.autoReview.action")}: {t(`chat.autoReview.actionType.${data.action.type}`)}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(data.action, null, 2)}</pre>
      <div>{t("chat.autoReview.risk")}: {level(data.review.riskLevel)}</div>
      <div>{t("chat.autoReview.authorization")}: {level(data.review.userAuthorization)}</div>
      <div className="whitespace-pre-wrap break-words">{t("chat.autoReview.rationale")}: {data.review.rationale || t("chat.autoReview.unknown")}</div>
    </div>
  </details>;
}
