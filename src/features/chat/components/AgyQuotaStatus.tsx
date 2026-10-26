import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon } from "@/components/base/action-feedback";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import type { AgyQuotaSnapshot } from "@/lib/ipc";
import { openExternal } from "@/lib/platform";
import {
  getAgyVertexCreditsUrl,
  useAgyVertexCredits,
} from "@/features/settings/agy-vertex-guardrail";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import { QuotaFact, QuotaMeter } from "./quota-meter";
import { agyQuotaModelGroup, compactQuotaReset, quotaResetCountdown, validAgyQuotaSnapshot } from "../agy-quota";
import { QUOTA_CREDITS_MAX_AGE } from "../subscription-quota";

export function AgyQuotaStatus({ snapshot, model, loading, refresh, now = Date.now() / 1000 }: {
  snapshot?: AgyQuotaSnapshot; model?: string; loading: boolean; refresh: () => Promise<void>; now?: number;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(open, () => setOpen(false), [triggerRef, popoverRef]);
  const allowOpenChange = useTriggerToggle(open, triggerRef);
  const { credits: vertexCredits, sync: syncVertexCredits, syncing: vertexSyncing } = useAgyVertexCredits();
  const quota = snapshot ? validAgyQuotaSnapshot(snapshot, now) : undefined;
  const activeId = agyQuotaModelGroup(model);
  const active = quota?.groups.find(group => group.id === activeId);
  const percentage = (used: number | undefined) => used === undefined ? "—" : `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(100 - used)}%`;
  const summary = activeId ? t("chat.agyQuotaRemainingSummary", { fiveHour: percentage(active?.windows.fiveHour?.usedPercentage), sevenDay: percentage(active?.windows.sevenDay?.usedPercentage) }) : t("chat.agyQuotaViewUsage");
  const resets = (["fiveHour", "sevenDay"] as const).flatMap(name => {
    const at = active?.windows[name]?.resetsAt;
    const time = compactQuotaReset(at, name, i18n.language, now);
    return at === undefined || time === undefined ? [] : [{ name, at, label: t(name === "fiveHour" ? "chat.quotaFiveHourResetShort" : "chat.quotaSevenDayResetShort", { time }) }];
  });
  const stale = quota?.status === "stale";
  const error = quota?.errorCode;
  const errorKey = error === "quota_expired" ? "chat.agyQuotaExpired" : error === "refresh_cooldown" ? "chat.agyQuotaCooldown" : error && /query_|read_failed|cli_unavailable/.test(error) ? "chat.agyQuotaQueryFailed" : "chat.agyQuotaUnavailable";
  const collectedAt = quota?.collectedAt;
  const validTime = quota?.status !== "unavailable" && collectedAt !== undefined && Number.isFinite(collectedAt) && collectedAt > 0 && collectedAt <= now && Number.isFinite(new Date(collectedAt * 1000).getTime());

  const hasFreeTrial = vertexCredits.freeTrialCredit != null;
  const hasGdp = vertexCredits.gdpMonthlyCredit != null;
  const hasVertexCredits = hasFreeTrial || hasGdp;
  const creditsUrl = getAgyVertexCreditsUrl(vertexCredits.billingAccountId);

  return <DialogTrigger isOpen={open} onOpenChange={next => { if (allowOpenChange(next)) setOpen(next); }}>
    <AriaButton ref={triggerRef} aria-label={`${t("chat.agyQuotaPlan")} · ${summary}${resets.length ? ` · ${resets.map(reset => reset.label).join(" · ")}` : ""}${stale ? ` · ${t("chat.quotaStaleShort")}` : ""}`}
      className="flex min-w-0 max-w-full cursor-pointer flex-wrap items-center justify-end gap-x-3 rounded-full bg-background-secondary-default px-2.5 py-1 text-caption-1-regular text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-tertiary-default active:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none">
      <span>{summary}{stale && <span className="text-text-warning-primary" aria-hidden> · {t("chat.quotaStaleShort")}</span>}</span>
    </AriaButton>
    <Popover ref={popoverRef} isNonModal placement="top end" offset={8}
      className="max-h-[calc(100dvh-2rem)] w-72 max-w-[calc(100vw-2rem)] origin-bottom-right overflow-y-auto rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-dropdown outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0 motion-reduce:transition-none">
      <Dialog aria-label={t("chat.agyQuotaDetails")} className="flex flex-col gap-3 outline-none">
        <h3 className="text-body-2-medium text-text-secondary">{t("chat.agyQuotaPlan")}</h3>
        {(["gemini", "third_party"] as const).map(id => {
          const group = quota?.groups.find(value => value.id === id);
          return <section key={id} className="flex flex-col gap-2" aria-label={t(id === "gemini" ? "chat.agyQuotaGemini" : "chat.agyQuotaThirdParty")}>
            <h4 className="text-caption-1-medium text-text-secondary">{t(id === "gemini" ? "chat.agyQuotaGemini" : "chat.agyQuotaThirdParty")}</h4>
            <dl className="flex flex-col gap-2">{(["fiveHour", "sevenDay"] as const).map(name => {
              const window = group?.windows[name];
              return <div key={name} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-secondary">
                  <dt>{t(name === "fiveHour" ? "chat.quotaFiveHour" : "chat.quotaSevenDay")}</dt>
                  <dd>{t("chat.agyQuotaRemaining", { percentage: percentage(window?.usedPercentage) })}</dd>
                </div>
                <QuotaMeter usedPercentage={window?.usedPercentage} remaining />
                <p className="text-caption-1-regular text-text-tertiary">
                  {window?.resetsAt === undefined ? t("chat.quotaResetUnknown") : window.resetsAt > now ? <>{t("chat.quotaResetAt", { time: new Date(window.resetsAt * 1000).toLocaleString(i18n.language) })} · {t("chat.quotaResetCountdown", quotaResetCountdown(window.resetsAt, now))}</> : null}
                </p>
              </div>;
            })}</dl>
          </section>;
        })}
        {quota && quota.status !== "unavailable" && quota.collectedAt !== undefined && now - quota.collectedAt < QUOTA_CREDITS_MAX_AGE && quota.credits && <dl><QuotaFact label={t("chat.agyQuotaCredits")}
          value={new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(quota.credits.remaining)} /></dl>}
        <div role="status" className="flex flex-col gap-1 text-caption-1-regular text-text-tertiary">
          {stale && <p>{t("chat.quotaStale")}</p>}
          {(!quota || quota.status === "unavailable" || error) && <p>{t(errorKey)}</p>}
          {validTime && <p>{t("chat.agyQuotaUpdated", { time: new Date(collectedAt * 1000).toLocaleString(i18n.language) })}</p>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border-button-default pt-2">
          <span className="text-caption-1-regular text-text-tertiary">{t("chat.agyQuotaSource")}</span>
          {/* Native quota only: a Vertex sync opens a Google sign-in window and stays opt-in below. */}
          <Button size="xs" disabled={loading} onClick={() => void refresh()}>
            <ActionFeedbackIcon icon={RefreshCw} feedback={loading ? "running" : "idle"} spin iconClassName="size-3" />
            {t(loading ? "chat.quotaRefreshing" : "chat.quotaRefresh")}
          </Button>
        </div>
        <section aria-label={t("chat.agyVertexCredits")} className="flex flex-col gap-2 border-t border-border-button-default pt-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-caption-1-medium text-text-secondary">{t("chat.agyVertexCredits")}</h4>
            <span className="text-caption-1-regular text-text-tertiary">
              {vertexCredits.billingAccountId || t("settings.agyVertexNotConnected")}
            </span>
          </div>
          {hasVertexCredits ? (
            <dl className="flex flex-col gap-2">
              {hasFreeTrial && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-secondary">
                    <dt>{t("chat.agyQuotaPromoTrial")}</dt>
                    <dd className="font-mono text-text-primary">
                      {vertexCredits.freeTrialCredit}
                      {vertexCredits.freeTrialOriginalCredit ? ` / ${vertexCredits.freeTrialOriginalCredit}` : ""}
                      {vertexCredits.freeTrialRemainingPercent != null ? ` (${vertexCredits.freeTrialRemainingPercent}%)` : ""}
                    </dd>
                  </div>
                  {vertexCredits.freeTrialRemainingPercent != null && (
                    <QuotaMeter usedPercentage={100 - vertexCredits.freeTrialRemainingPercent} remaining />
                  )}
                </div>
              )}
              {hasGdp && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-secondary">
                    <dt>{t("chat.agyQuotaPromoGdp")}</dt>
                    <dd className="font-mono text-text-primary">
                      {vertexCredits.gdpMonthlyCredit}
                      {vertexCredits.gdpMonthlyRemainingPercent != null ? ` (${vertexCredits.gdpMonthlyRemainingPercent}%)` : ""}
                    </dd>
                  </div>
                  {vertexCredits.gdpMonthlyRemainingPercent != null && (
                    <QuotaMeter usedPercentage={100 - vertexCredits.gdpMonthlyRemainingPercent} remaining />
                  )}
                </div>
              )}
            </dl>
          ) : (
            <div className="rounded bg-background-secondary-default p-2 text-caption-1-regular text-text-secondary">
              <p>{t("settings.agyVertexStepsGuide")}</p>
              <p className="mt-1 text-text-tertiary">
                {vertexCredits.errorCode && vertexCredits.errorCode !== "not_connected"
                  ? vertexCredits.errorCode === "sync_cancelled"
                    ? t("settings.agyVertexErrorCancelled")
                    : vertexCredits.errorCode === "permission_denied"
                      ? t("settings.agyVertexErrorPermissionDenied")
                      : vertexCredits.errorCode
                  : t("settings.agyVertexNotSynced")}
              </p>
            </div>
          )}
          <p className="text-caption-1-regular text-text-tertiary">{t("chat.agyVertexCreditsNote")}</p>
          <div className="flex items-center justify-between gap-2">
            <Button size="xs" disabled={vertexSyncing} onClick={() => void syncVertexCredits()}>
              <ActionFeedbackIcon icon={RefreshCw} feedback={vertexSyncing ? "running" : "idle"} spin iconClassName="size-3" />
              {t(vertexSyncing ? "settings.agyVertexSyncing" : "settings.agyVertexSignInSync")}
            </Button>
            <Button size="xs" onClick={() => openExternal(creditsUrl)}>
              <ExternalLink className="size-3" aria-hidden />
              {t("settings.agyVertexGuardrailOpenCredits")}
            </Button>
          </div>
        </section>
      </Dialog>
    </Popover>
  </DialogTrigger>;
}
