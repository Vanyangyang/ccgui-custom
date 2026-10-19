import { useTranslation } from "react-i18next";
import { isWeb, useAssistantNoticeFeed } from "./api";
import { NoticeCard, NoticeFeedFeedback } from "./AssistantNoticesOverlay";
import type { AssistantNoticeSource } from "./types";
import { noticeTextStyle } from "./config";

export type InlineAsideSource = Pick<AssistantNoticeSource, "engine" | "sessionId" | "workspacePath">;

/** The caller supplies the active native session identity; drafts still use the confirmed native focus path. */
export function InlineAside({ source }: { source: InlineAsideSource | null }) {
  const { t } = useTranslation();
  const { notices, status, error, retry, reload } = useAssistantNoticeFeed("list", source !== null);
  if (isWeb || !source || status?.enabled === false) return null;
  const asides = notices.filter(notice => notice.kind === "aside" && !notice.read
    && notice.source.engine === source.engine && notice.source.sessionId === source.sessionId && notice.source.workspacePath === source.workspacePath)
    .sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 2);
  if (asides.length === 0 && !error) return null;
  return <section className="assistant-notices-inline" style={noticeTextStyle(status)} aria-label={t("assistantNotices.aside")}>
    {asides.map(notice => <NoticeCard key={notice.id} notice={notice} status={status} reload={reload} />)}
    <NoticeFeedFeedback error={error} retry={retry} />
  </section>;
}
