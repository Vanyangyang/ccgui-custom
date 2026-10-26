import { useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Copy from "lucide-react/dist/esm/icons/copy";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { useSettingsAnchorFlash } from "@/components/application/settings/settings-rows";
import { ModalShell } from "@/components/dialogs";
import { useCopied } from "@/hooks/use-copied";
import { openExternal } from "@/lib/platform";
import { cx } from "@/utils/cx";
import { ROW } from "./CliChannelRow";
import {
  agyVertexEndpoint,
  agyVertexSampleCommand,
  agyVertexStreamEndpoint,
  getAgyVertexBillingOverviewUrl,
  getAgyVertexCreditsUrl,
  getAgyVertexProjectUrl,
  useAgyVertexConfig,
  useAgyVertexCredits,
} from "./agy-vertex-guardrail";

/** 【Vertex 防护】只在 Antigravity 引擎设置里提供详细入口。 */
export function AgyVertexGuardrailRow() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const flashing = useSettingsAnchorFlash("agyVertexGuardrail");
  return (
    <>
      <div
        data-setting-anchor="agyVertexGuardrail"
        role="button"
        tabIndex={0}
        className={cx(
          ROW,
          "cursor-pointer",
          flashing && "rounded-2lg ring-2 ring-inset ring-border-focus-ring",
        )}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-body-regular text-text-primary">
            {t("settings.agyVertexTitle")}
          </p>
          <p className="truncate text-body-2-regular text-text-secondary">
            {t("settings.agyVertexDesc")}
          </p>
        </div>
        <span
          aria-label={t("settings.agyVertexTitle")}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary"
        >
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </div>
      {open && <AgyVertexGuardrailDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-body-2-regular text-text-tertiary">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-body-2-regular text-text-primary">
        {value}
      </span>
    </div>
  );
}

function ExternalLinkButton({ label, url }: { label: string; url: string }) {
  return (
    <Button
      variant="secondary"
      size="small"
      aria-label={label}
      title={url}
      onClick={() => openExternal(url)}
    >
      <span>{label}</span>
      <ExternalLink className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
    </Button>
  );
}

function CopyButton({
  label,
  copiedLabel,
  text,
  disabled = false,
}: {
  label: string;
  copiedLabel: string;
  text: string;
  disabled?: boolean;
}) {
  const { copied, copy } = useCopied();
  const currentLabel = copied ? copiedLabel : label;
  return (
    <Button
      variant="secondary"
      size="small"
      aria-label={currentLabel}
      title={currentLabel}
      disabled={disabled || !text}
      onClick={() => copy(text)}
    >
      {copied ? (
        <Check className="size-3.5 shrink-0 text-foreground-icon-primary" aria-hidden />
      ) : (
        <Copy className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
      )}
      <span>{currentLabel}</span>
    </Button>
  );
}

function AgyVertexGuardrailDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { config } = useAgyVertexConfig();
  const { credits: vertexCredits, syncing, sync } = useAgyVertexCredits();

  const endpoint = agyVertexEndpoint(config.projectId, config.location, config.model);
  const streamEndpoint = agyVertexStreamEndpoint(
    config.projectId,
    config.location,
    config.model,
  );
  const sampleCommand = agyVertexSampleCommand(
    config.projectId,
    config.location,
    config.model,
    config.keyFileHint,
  );

  const creditsUrl = getAgyVertexCreditsUrl(vertexCredits.billingAccountId);
  const billingOverviewUrl = getAgyVertexBillingOverviewUrl(vertexCredits.billingAccountId);
  const copiedLabel = t("settings.agyVertexCopied");

  // 错误信息映射
  let syncErrorMessage: string | null = null;
  if (vertexCredits.errorCode && vertexCredits.errorCode !== "not_connected") {
    switch (vertexCredits.errorCode) {
      case "sync_cancelled":
        syncErrorMessage = t("settings.agyVertexErrorCancelled");
        break;
      case "permission_denied":
        syncErrorMessage = t("settings.agyVertexErrorPermissionDenied");
        break;
      case "login_timeout":
        syncErrorMessage = t("settings.agyVertexErrorLoginTimeout");
        break;
      case "scrape_timeout":
        syncErrorMessage = t("settings.agyVertexErrorScrapeTimeout");
        break;
      case "webview_create_failed":
        syncErrorMessage = t("settings.agyVertexErrorWebviewFailed");
        break;
      default:
        syncErrorMessage = vertexCredits.errorCode;
        break;
    }
  }

  const freeTrialText = vertexCredits.freeTrialCredit
    ? `${vertexCredits.freeTrialCredit}${
        vertexCredits.freeTrialOriginalCredit ? ` / ${vertexCredits.freeTrialOriginalCredit}` : ""
      }${
        vertexCredits.freeTrialRemainingPercent != null
          ? ` (${vertexCredits.freeTrialRemainingPercent}%)`
          : ""
      }`
    : "—";

  const gdpCreditText = vertexCredits.gdpMonthlyCredit
    ? `${vertexCredits.gdpMonthlyCredit}${
        vertexCredits.gdpMonthlyRemainingPercent != null
          ? ` (${vertexCredits.gdpMonthlyRemainingPercent}%)`
          : ""
      }`
    : "—";

  return (
    <ModalShell
      onClose={onClose}
      label={t("settings.agyVertexTitle")}
      className="max-h-[calc(100vh-48px)] w-[660px] max-w-[calc(100vw-32px)] overflow-y-auto p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-title-3-medium text-text-primary">{t("settings.agyVertexTitle")}</p>
        <button
          type="button"
          aria-label={t("common.cancel")}
          title={t("common.cancel")}
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="mt-1.5 text-body-2-regular text-text-secondary">
        {t("settings.agyVertexDialogIntro")}
      </p>

      {/* 1. 剩余额度与赠金查询 */}
      <section className="mt-5 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-medium text-text-primary">{t("settings.agyVertexCreditsTitle")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={syncing}
              onClick={() => void sync()}
            >
              <RefreshCw
                className={cx("size-3.5 shrink-0 text-foreground-icon-secondary", syncing && "animate-spin")}
                aria-hidden
              />
              <span>
                {syncing
                  ? t("settings.agyVertexSyncing")
                  : vertexCredits.billingAccountId
                    ? t("settings.agyVertexSwitchAccount")
                    : t("settings.agyVertexSignInSync")}
              </span>
            </Button>
            <ExternalLinkButton
              label={t("settings.agyVertexOpenCredits")}
              url={creditsUrl}
            />
            <ExternalLinkButton
              label={t("settings.agyVertexOpenBillingOverview")}
              url={billingOverviewUrl}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border-button-default bg-background-secondary-default p-3">
          <div className="rounded bg-background-tertiary px-2.5 py-1 text-caption-1-regular text-text-secondary">
            {t("settings.agyVertexStepsGuide")}
          </div>

          {syncErrorMessage ? (
            <div className="rounded bg-notification-error-background px-2.5 py-1 text-caption-1-regular text-notification-error-foreground">
              {syncErrorMessage}
            </div>
          ) : null}

          <Fact
            label={t("settings.agyVertexBillingAccount")}
            value={vertexCredits.billingAccountId || t("settings.agyVertexNotConnected")}
          />
          <Fact
            label={t("settings.agyVertexCreditFreeTrial")}
            value={freeTrialText}
          />
          <Fact
            label={t("settings.agyVertexCreditGdp")}
            value={gdpCreditText}
          />
          <p className="mt-1 border-t border-border-button-default pt-2 text-caption-1-regular text-text-secondary">
            {t("settings.agyVertexCreditsApiNote")}
          </p>
          <p className="text-caption-1-regular text-text-tertiary">
            {t("settings.agyVertexWebSignInNote")}
          </p>
        </div>
      </section>

      {/* 2. 接入参数与调用地址 */}
      <section className="mt-5 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-medium text-text-primary">{t("settings.agyVertexAccess")}</p>
          <ExternalLinkButton
            label={t("settings.agyVertexOpenStudio")}
            url={getAgyVertexProjectUrl("studio", config.projectId)}
          />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-border-button-default p-3">
          <Fact
            label={t("settings.agyVertexProject")}
            value={config.projectId || t("settings.agyVertexProjectUnconfigured")}
          />
          <Fact label={t("settings.agyVertexModel")} value={config.model} />
          <Fact label={t("settings.agyVertexLocation")} value={config.location} />
          <Fact label={t("settings.agyVertexHeader")} value="x-goog-api-key" />
          <p className="text-caption-1-regular text-text-tertiary">
            {t("settings.agyVertexKeyFile", { path: config.keyFileHint })}
          </p>

          <div className="mt-1 flex flex-col gap-1.5 border-t border-border-button-default pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption-1-medium text-text-secondary">
                {t("settings.agyVertexEndpointSyncLabel")}
              </span>
              <CopyButton
                label={t("settings.agyVertexCopyEndpoint")}
                copiedLabel={copiedLabel}
                text={endpoint || ""}
                disabled={!endpoint}
              />
            </div>
            <p className="break-all rounded-md bg-background-secondary-default px-2.5 py-1.5 font-mono text-caption-1-regular text-text-secondary">
              {endpoint || t("settings.agyVertexEndpointUnconfigured")}
            </p>
          </div>

          <div className="mt-1 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption-1-medium text-text-secondary">
                {t("settings.agyVertexEndpointStreamLabel")}
              </span>
              <CopyButton
                label={t("settings.agyVertexCopyStreamEndpoint")}
                copiedLabel={copiedLabel}
                text={streamEndpoint || ""}
                disabled={!streamEndpoint}
              />
            </div>
            <p className="break-all rounded-md bg-background-secondary-default px-2.5 py-1.5 font-mono text-caption-1-regular text-text-secondary">
              {streamEndpoint || t("settings.agyVertexEndpointUnconfigured")}
            </p>
          </div>
        </div>
      </section>

      {/* 3. 如何设置与调用 API */}
      <section className="mt-5 flex flex-col gap-2.5">
        <p className="text-body-medium text-text-primary">{t("settings.agyVertexSetupTitle")}</p>
        <div className="flex flex-col gap-2.5">
          <div className="rounded-lg border border-border-button-default px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-body-2-medium text-text-primary">{t("settings.agyVertexStep1Title")}</p>
              <ExternalLinkButton
                label={t("settings.agyVertexOpenCredentials")}
                url={getAgyVertexProjectUrl("credentials", config.projectId)}
              />
            </div>
            <p className="mt-1 text-body-2-regular text-text-secondary">{t("settings.agyVertexStep1Body")}</p>
          </div>

          <div className="rounded-lg border border-border-button-default px-3 py-2.5">
            <p className="text-body-2-medium text-text-primary">{t("settings.agyVertexStep2Title")}</p>
            <p className="mt-1 text-body-2-regular text-text-secondary">
              {t("settings.agyVertexStep2Body", { path: config.keyFileHint })}
            </p>
          </div>

          <div className="rounded-lg border border-border-button-default px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-body-2-medium text-text-primary">{t("settings.agyVertexStep3Title")}</p>
              <CopyButton
                label={t("settings.agyVertexCopySample")}
                copiedLabel={copiedLabel}
                text={sampleCommand || ""}
                disabled={!sampleCommand}
              />
            </div>
            <p className="mt-1 text-body-2-regular text-text-secondary">{t("settings.agyVertexStep3Body")}</p>
            {sampleCommand ? (
              <pre className="mt-2 overflow-x-auto rounded-md bg-background-secondary-default p-2.5 font-mono text-caption-1-regular text-text-secondary">
                {sampleCommand}
              </pre>
            ) : (
              <p className="mt-2 rounded-md bg-background-secondary-default p-2.5 text-caption-1-regular text-text-tertiary">
                {t("settings.agyVertexSampleUnconfigured")}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border-button-default px-3 py-2.5">
            <p className="text-body-2-medium text-text-primary">{t("settings.agyVertexModelNamingTitle")}</p>
            <p className="mt-1 text-body-2-regular text-text-secondary">{t("settings.agyVertexModelNamingBody")}</p>
          </div>
        </div>
      </section>

      {/* 4. 三道防护 */}
      <section className="mt-5 flex flex-col gap-2.5">
        <p className="text-body-medium text-text-primary">{t("settings.agyVertexGuards")}</p>
        <Guard
          title={t("settings.agyVertexSpendTitle")}
          body={t("settings.agyVertexSpendBody")}
          actionLabel={t("settings.agyVertexOpenBudgets")}
          actionUrl={getAgyVertexProjectUrl("budgets", config.projectId)}
        />
        <Guard
          title={t("settings.agyVertexTheftTitle")}
          body={t("settings.agyVertexTheftBody")}
          actionLabel={t("settings.agyVertexOpenPolicies")}
          actionUrl={getAgyVertexProjectUrl("policies", config.projectId)}
        />
        <Guard
          title={t("settings.agyVertexAbuseTitle")}
          body={t("settings.agyVertexAbuseBody")}
          actionLabel={t("settings.agyVertexOpenQuotas")}
          actionUrl={getAgyVertexProjectUrl("quotas", config.projectId)}
        />
      </section>

      <p className="mt-4 text-body-2-regular text-text-secondary">{t("settings.agyVertexUpgradeWarning")}</p>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button size="small" onClick={onClose}>
          {t("common.confirm")}
        </Button>
      </div>
    </ModalShell>
  );
}

function Guard({
  title,
  body,
  actionLabel,
  actionUrl,
}: {
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
}) {
  return (
    <div className="rounded-lg border border-border-button-default px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-2-medium text-text-primary">{title}</p>
        <ExternalLinkButton label={actionLabel} url={actionUrl} />
      </div>
      <p className="mt-1 text-body-2-regular text-text-secondary">{body}</p>
    </div>
  );
}
