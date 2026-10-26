import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon } from "@/components/base/action-feedback";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { CursorQuotaSnapshot } from "@/lib/ipc";
import { openExternal } from "@/lib/platform";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import { CURSOR_USAGE_URL, cursorQuotaReady, formatCursorQuotaPercent } from "../cursor-quota";
import { QuotaMeter } from "./quota-meter";

// 【Cursor 用量】状态栏只展示 Auto 与其他模型。提取发生在后端，这里不接触登录态。
export function CursorQuotaStatus({ snapshot, loading, refresh, now = Date.now() / 1000 }: {
  snapshot?: CursorQuotaSnapshot; loading: boolean; refresh: () => Promise<void>; now?: number;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(open, () => setOpen(false), [triggerRef, popoverRef]);
  const allowOpenChange = useTriggerToggle(open, triggerRef);
  const ready = cursorQuotaReady(snapshot) ? snapshot : undefined;
  // 【Cursor 用量】Included 的金额池和官网、CLI 上能看到的用量对不上，面板只保留 Auto 与其他模型。
  const auto = formatCursorQuotaPercent(ready?.autoPercent);
  const api = formatCursorQuotaPercent(ready?.apiPercent);
  const summary = ready?.autoPercent !== undefined || ready?.apiPercent !== undefined
    ? t("chat.cursorQuotaSummary", { auto, api })
    : t("chat.cursorUsageView");
  const resetsAt = ready?.resetsAt;
  const resetDate = resetsAt !== undefined && resetsAt > now ? new Date(resetsAt * 1000) : undefined;
  const stale = ready?.status === "stale";
  const error = snapshot?.errorCode;
  const errorKey = error === "auth" || error === "not_logged_in" ? "chat.cursorQuotaAuth"
    : error === "plan_unsupported" ? "chat.cursorQuotaUnsupported"
    : error && error !== "not_loaded" ? "chat.cursorQuotaQueryFailed" : undefined;
  const rows: Array<{ id: string; label: string; hint: string; percent?: number; text: string; message?: string }> = [
    { id: "auto", label: t("chat.cursorQuotaAuto"), hint: t("chat.cursorQuotaAutoHint"), percent: ready?.autoPercent, text: auto, message: ready?.autoMessage },
    { id: "api", label: t("chat.cursorQuotaApi"), hint: t("chat.cursorQuotaApiHint"), percent: ready?.apiPercent, text: api, message: ready?.apiMessage },
  ];
  return <DialogTrigger isOpen={open} onOpenChange={next => { if (allowOpenChange(next)) setOpen(next); }}>
    <AriaButton ref={triggerRef} aria-label={`${t("chat.cursorQuotaPlan")} · ${summary}${stale ? ` · ${t("chat.quotaStaleShort")}` : ""}`}
      className="flex min-w-0 max-w-full cursor-pointer flex-wrap items-center justify-end gap-x-3 rounded-full px-1.5 py-1 text-caption-1-regular text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-tertiary-default active:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none">
      <span className="whitespace-nowrap">{summary}{stale && <span className="text-text-warning-primary" aria-hidden> · {t("chat.quotaStaleShort")}</span>}</span>
    </AriaButton>
    <Popover ref={popoverRef} isNonModal placement="top end" offset={8}
      className="w-80 max-w-[calc(100vw-2rem)] origin-bottom-right rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-dropdown outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0 motion-reduce:transition-none">
      <Dialog aria-label={t("chat.cursorQuotaDetails")} className="flex flex-col gap-3 outline-none">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-body-2-medium text-text-secondary">{t("chat.cursorQuotaPlan")}</h3>
          <p className="text-right text-caption-1-regular text-text-tertiary">{ready?.planName ?? t("chat.quotaIdentityUnknown")}</p>
        </div>
        {rows.map(row => <section key={row.id} className="flex flex-col gap-1" aria-label={row.label}>
          <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-secondary">
            <h4>{row.label}<span className="text-text-tertiary"> · {row.hint}</span></h4>
            <p className="tabular-nums">{row.text}</p>
          </div>
          <QuotaMeter usedPercentage={row.percent} />
          {row.message && <p className="text-caption-1-regular text-text-tertiary">{row.message}</p>}
        </section>)}
        <div role="status" className="flex flex-col gap-1 text-caption-1-regular text-text-tertiary">
          <p>{t("chat.cursorQuotaScope")}</p>
          {resetDate && <p>{t("chat.quotaResetAt", { time: resetDate.toLocaleString(i18n.language) })}</p>}
          {stale && <p>{t("chat.quotaStale")}</p>}
          {ready?.collectedAt !== undefined && Number.isFinite(ready.collectedAt) && ready.collectedAt > 0 && ready.collectedAt <= now && Number.isFinite(new Date(ready.collectedAt * 1000).getTime()) && <p>{t("chat.quotaUpdated", { time: new Date(ready.collectedAt * 1000).toLocaleString(i18n.language) })}</p>}
          {errorKey && <p>{t(errorKey)}</p>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border-button-default pt-2">
          <Button size="xs" onClick={() => openExternal(CURSOR_USAGE_URL)}>
            <ExternalLink className="size-3" aria-hidden />
            {t("chat.cursorQuotaOpen")}
          </Button>
          <Button size="xs" disabled={loading} onClick={() => { void refresh(); }}>
            <ActionFeedbackIcon icon={RefreshCw} feedback={loading ? "running" : "idle"} spin iconClassName="size-3" />
            {t(loading ? "chat.quotaRefreshing" : "chat.quotaRefresh")}
          </Button>
        </div>
      </Dialog>
    </Popover>
  </DialogTrigger>;
}
