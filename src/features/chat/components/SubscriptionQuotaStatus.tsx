import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon } from "@/components/base/action-feedback";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { ClaudeQuotaSnapshot, CodexQuotaSnapshot } from "@/lib/ipc";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import { QUOTA_CREDITS_MAX_AGE, compactQuotaReset, quotaResetCountdown, validSubscriptionQuotaSnapshot } from "../subscription-quota";
import { QuotaFact, QuotaMeter } from "./quota-meter";

export function SubscriptionQuotaStatus({ engine = "claude", snapshot, loading, refresh, now = Date.now() / 1000 }: {
  engine?: "claude" | "codex";
  snapshot?: ClaudeQuotaSnapshot | CodexQuotaSnapshot;
  loading: boolean;
  refresh: () => Promise<void>;
  now?: number;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(open, () => setOpen(false), [triggerRef, popoverRef]);
  const allowOpenChange = useTriggerToggle(open, triggerRef);
  const conversationQuota = engine === "claude";
  const quota = snapshot
    ? validSubscriptionQuotaSnapshot(snapshot, now)
    : undefined;
  const fiveHourUsed = quota?.windows.fiveHour?.usedPercentage;
  const fiveHourRemaining = fiveHourUsed === undefined ? undefined : 100 - fiveHourUsed;
  const sevenDayUsed = quota?.windows.sevenDay?.usedPercentage;
  const sevenDayRemaining = sevenDayUsed === undefined ? undefined : 100 - sevenDayUsed;
  // Credits and reset chances are informational and only trusted while the
  // snapshot itself is valid; they are never redeemed from here.
  const codexData = engine === "codex" && quota && quota.status !== "unavailable" && quota.collectedAt !== undefined && now - quota.collectedAt < QUOTA_CREDITS_MAX_AGE ? quota as CodexQuotaSnapshot : undefined;
  const codexCredits = codexData?.credits;
  const codexResets = codexData?.resetCredits;
  const plan = t(engine === "codex" ? "chat.codexQuotaPlan" : "chat.quotaPlan");
  const percentage = (value: number | undefined) => value === undefined ? "—" : `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(value)}%`;
  const summary = t("chat.quotaSummary", {
    fiveHour: percentage(fiveHourRemaining),
    sevenDay: percentage(sevenDayRemaining),
  });
  const resets = (["fiveHour", "sevenDay"] as const).flatMap(name => {
    const resetsAt = quota?.windows[name]?.resetsAt;
    const time = compactQuotaReset(resetsAt, name, i18n.language, now);
    return time === undefined || resetsAt === undefined ? [] : [{
      name,
      date: new Date(resetsAt * 1000),
      label: t(name === "fiveHour" ? "chat.quotaFiveHourResetShort" : "chat.quotaSevenDayResetShort", { time }),
    }];
  });
  const resetSummary = resets.map(reset => reset.label).join(" · ");
  const stale = quota?.status === "stale";
  const error = quota?.errorCode;
  // 【对话额度】Claude 不再发起受保护的额度请求。旧的 protection 错误码按普通不可用显示。
  const errorKey = engine === "codex" && error && /auth|provider|custom_channel/.test(error)
    ? "chat.codexQuotaAuthUnavailable"
    : engine === "codex" && error === "refresh_cooldown" ? "chat.codexQuotaCooldown"
    : engine === "codex" && error && /query_|read_failed|cli_unavailable/.test(error) ? "chat.codexQuotaQueryFailed"
    : engine === "codex" && error && /proxy|guard|firewall|protection/.test(error)
    ? "chat.quotaProtectionUnavailable"
    : error && /auth|provider/.test(error) ? "chat.quotaAuthUnavailable"
    : error === "quota_expired" ? "chat.quotaExpired" : "chat.quotaUnavailable";
  const collectedAt = quota?.collectedAt;
  const validCollectedAt = collectedAt !== undefined && Number.isFinite(collectedAt) && collectedAt > 0 && collectedAt <= now && Number.isFinite(new Date(collectedAt * 1000).getTime());
  // 【对话额度】Claude 详情保留两个窗口和更新时间。账号、计划和手动刷新拿不到新数据，不占面板。
  const showAccount = !conversationQuota || Boolean(quota?.account?.email);
  const showPlan = !conversationQuota || Boolean(quota?.account?.plan);
  const showStale = stale && !conversationQuota;
  const showCollectedAt = validCollectedAt;
  const showError = !quota || quota.status === "unavailable" || (engine === "codex" && Boolean(error));

  return <DialogTrigger isOpen={open} onOpenChange={next => { if (allowOpenChange(next)) setOpen(next); }}>
    <AriaButton
      ref={triggerRef}
      aria-label={`${plan} · ${summary}${resetSummary ? ` · ${resetSummary}` : ""}${showStale ? ` · ${t("chat.quotaStaleShort")}` : ""}`}
      className="flex min-w-0 max-w-full cursor-pointer flex-wrap items-center justify-end gap-x-3 rounded-full bg-background-secondary-default px-2.5 py-1 text-caption-1-regular text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-tertiary-default active:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none"
    >
      {resets.length > 0 && <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2">
        {resets.map(reset => <time key={reset.name} dateTime={reset.date.toISOString()}
          title={t("chat.quotaResetAt", { time: reset.date.toLocaleString(i18n.language) })}
          className="whitespace-nowrap">{reset.label}</time>)}
      </span>}
      <span className="whitespace-nowrap">{summary}{showStale && <span className="text-text-warning-primary" aria-hidden> · {t("chat.quotaStaleShort")}</span>}</span>
    </AriaButton>
    <Popover ref={popoverRef} isNonModal placement="top end" offset={8}
      className="w-72 max-w-[calc(100vw-2rem)] origin-bottom-right rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-dropdown outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0 motion-reduce:transition-none">
      <Dialog aria-label={t(engine === "codex" ? "chat.codexQuotaDetails" : "chat.quotaDetails")} className="flex flex-col gap-3 outline-none">
        <div className="flex flex-col gap-2">
          <h3 className="text-body-2-medium text-text-secondary">{plan}</h3>
          {(showAccount || showPlan) && <dl className="flex flex-col gap-1 text-caption-1-regular">
            {showAccount && <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-text-tertiary">{t("chat.quotaAccount")}</dt>
              <dd className="min-w-0 break-all text-right text-text-secondary">{quota?.account?.email ?? t("chat.quotaIdentityUnknown")}</dd>
            </div>}
            {showPlan && <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-text-tertiary">{t("chat.quotaSubscriptionPlan")}</dt>
              <dd className="min-w-0 break-words text-right text-text-secondary">{quota?.account?.plan ?? t("chat.quotaIdentityUnknown")}</dd>
            </div>}
          </dl>}
        </div>
        <dl className="flex flex-col gap-3">
          {(["fiveHour", "sevenDay"] as const).map(name => {
            const window = quota?.windows[name];
            return <div key={name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-secondary">
                <dt>{t(name === "fiveHour" ? "chat.quotaFiveHourRemaining" : "chat.quotaSevenDayRemaining")}</dt>
                <dd>{percentage(name === "fiveHour" ? fiveHourRemaining : sevenDayRemaining)}</dd>
              </div>
              <QuotaMeter usedPercentage={window?.usedPercentage} remaining />
              <p className="text-caption-1-regular text-text-tertiary">
                {/* 【对话额度】重置时间已过时保留上次比例，只去掉倒计时；从未提供重置时间时仍说明未提供。 */}
                {window?.resetsAt !== undefined && window.resetsAt > now ? <>
                  {t("chat.quotaResetAt", { time: new Date(window.resetsAt * 1000).toLocaleString(i18n.language) })}
                  {" · "}{t("chat.quotaResetCountdown", quotaResetCountdown(window.resetsAt, now))}
                </> : window?.resetsAt === undefined ? t("chat.quotaResetUnknown") : null}
              </p>
            </div>;
          })}
          {engine === "codex" && codexCredits && <QuotaFact label={t("chat.quotaCredits")}
            value={codexCredits.unlimited ? t("chat.quotaCreditsUnlimited") : codexCredits.balance ?? (codexCredits.hasCredits ? "—" : "0")} />}
          {engine === "codex" && codexResets && <QuotaFact label={t("chat.quotaResetChances")} value={String(codexResets.availableCount)}
            note={codexResets.nextExpiresAt === undefined ? undefined : t("chat.quotaResetChanceExpires", { time: new Date(codexResets.nextExpiresAt * 1000).toLocaleString(i18n.language) })} />}
        </dl>

        {(showStale || showError || showCollectedAt) && <div className="flex flex-col gap-1 text-caption-1-regular text-text-tertiary" role="status">
          {showStale && <p>{t("chat.quotaStale")}</p>}
          {showError && <p>{t(errorKey)}</p>}
          {showCollectedAt && collectedAt !== undefined && <p>{t("chat.quotaUpdated", { time: new Date(collectedAt * 1000).toLocaleString(i18n.language) })}</p>}
        </div>}
        {!conversationQuota && <div className="flex items-center justify-between gap-2 border-t border-border-button-default pt-2">
          <span className="text-caption-1-regular text-text-tertiary">{t("chat.codexQuotaSource")}</span>
          <Button size="xs" disabled={loading} onClick={() => { void refresh(); }}>
            <ActionFeedbackIcon icon={RefreshCw} feedback={loading ? "running" : "idle"} spin iconClassName="size-3" />
            {t(loading ? "chat.quotaRefreshing" : "chat.quotaRefresh")}
          </Button>
        </div>}
      </Dialog>
    </Popover>
  </DialogTrigger>;
}
