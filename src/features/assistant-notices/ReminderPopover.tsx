import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import Bell from "lucide-react/dist/esm/icons/bell";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { assistantNotices, isWeb, useAssistantNoticeFeed } from "./api";
import { CompletionList, NoticeCard, NoticeFeedFeedback } from "./AssistantNoticesOverlay";
import { noticeConfig, noticeConfigError, noticeTextStyle } from "./config";

/** Mount in the main chat toolbar. Native history is bounded, and never marks entries read. */
export function ReminderPopover() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const alive = useRef(true);
  const savePending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const { notices, status, error, loading, reload, retry } = useAssistantNoticeFeed("history");
  async function enable() {
    if (!status || savePending.current) return;
    savePending.current = true; setSaving(true); setSaveError("");
    try {
      await assistantNotices.configure({ ...noticeConfig(status), enabled: true }, status.revision);
      if (alive.current) reload();
    } catch (cause) { if (alive.current) setSaveError(noticeConfigError(cause)); }
    finally { savePending.current = false; if (alive.current) setSaving(false); }
  }
  if (isWeb) return null;
  const completions = notices.filter(notice => notice.kind === "completion" && !notice.read).sort((a, b) => b.createdAtMs - a.createdAtMs);
  const asides = notices.filter(notice => notice.kind === "aside").sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 10);
  return <DialogTrigger isOpen={open} onOpenChange={value => { setOpen(value); if (value) reload(); }}>
    <Button aria-label={status?.enabled === false ? t("assistantNotices.disabledStatus") : t("assistantNotices.inboxLabel", { count: completions.length })}
      className="assistant-notices-bell shrink-0 cursor-pointer rounded-md p-1.5 text-text-secondary outline-none transition-colors duration-150 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring">
      <Bell size={16} aria-hidden />
      {status?.enabled && completions.length > 0 && <span className="assistant-notices-count" aria-hidden>{completions.length > 99 ? "99+" : completions.length}</span>}
    </Button>
    <Popover placement="bottom end" className={menuPopoverSurface({ width: "w-96", origin: "origin-top-right", padding: "p-3" })}>
      <Dialog aria-label={t("assistantNotices.title")} className="assistant-notices-inbox outline-none" style={noticeTextStyle(status)} aria-busy={loading}>
        <h2 className="text-body-medium text-text-primary">{t("assistantNotices.title")}</h2>
        {status?.enabled === false && <div className="assistant-notices-disabled">
          <p>{t("assistantNotices.disabledStatus")}</p>
          <Button isDisabled={saving} onPress={() => { void enable(); }} className="cursor-pointer rounded-md p-1 text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">{t("assistantNotices.enabled")}</Button>
        </div>}
        <NoticeFeedFeedback error={Boolean(saveError)} errorKey={saveError} retry={async () => { await retry(); setSaveError(""); }} />
        {completions.length > 0 && <section aria-label={t("assistantNotices.completions")}>
          <h3 className="assistant-notices-section-label">{t("assistantNotices.completions")}</h3>
          <CompletionList notices={completions} status={status} reload={reload} />
        </section>}
        {asides.length > 0 && <section aria-label={t("assistantNotices.recentAsides")}>
          <h3 className="assistant-notices-section-label">{t("assistantNotices.recentAsides")}</h3>
          {asides.map(notice => <NoticeCard key={notice.id} notice={notice} status={status} reload={reload} archived />)}
        </section>}
        {!loading && !error && notices.length === 0 && <p className="assistant-notices-empty">{t("assistantNotices.empty")}</p>}
        <NoticeFeedFeedback error={error} retry={retry} />
      </Dialog>
    </Popover>
  </DialogTrigger>;
}
