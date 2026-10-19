import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import BookOpen from "lucide-react/dist/esm/icons/book-open";
import Download from "lucide-react/dist/esm/icons/download";
import Check from "lucide-react/dist/esm/icons/check";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { useTranslation } from "react-i18next";
import { ActionFeedbackIcon, useRunningFeedback } from "@/components/base/action-feedback";
import { Button } from "@/components/base/buttons/button";
import type { CliVersionStatus } from "@/lib/ipc";
import { openExternal } from "@/lib/platform";
import { cx } from "@/utils/cx";
import { ENGINE_DOCS_URLS, type EngineId } from "./providers";
import { CliUpdateDialog } from "./CliUpdateDialog";
import { useCliUpdateFlow } from "./useCliUpdateFlow";
import { useCliVersionStatus } from "./useCliVersionStatus";

/**
 * CLI 管理 page-header cluster: icon-only docs and refresh buttons flanking
 * a single segmented pill — the left segment carries the version status
 * (checking / not installed / local version + ✓ or ↑), the right segment is
 * the install/update CTA naming the target version. One piece of information
 * (current → target) reads as one control, and every element shares the
 * small-button 32px height.
 *
 * Version data comes from the shared session store (useCliVersionStatus) —
 * probes run on mount and the refresh button only, so opening settings never
 * blocks on `npm view`.
 */
export function CliHeaderActions({ engine }: { engine: EngineId }) {
  const { t } = useTranslation();
  const { status, loading, error, updating, refresh } = useCliVersionStatus(engine);
  const updateFlow = useCliUpdateFlow(engine);
  // Store-driven: the probe also runs on mount, and the button should read as
  // busy whenever one is in flight, whoever started it.
  const refreshFeedback = useRunningFeedback(loading || updating);

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2" title={error ?? undefined}>
      <Button
        iconOnly
        size="small"
        variant="ghost"
        leadingIcon={BookOpen}
        aria-label={t("settings.cliDocs")}
        onClick={() => openExternal(ENGINE_DOCS_URLS[engine])}
      />
      <Button
        iconOnly
        size="small"
        variant="ghost"
        aria-label={t("settings.cliRefresh")}
        disabled={loading || updating}
        onClick={refresh}
      >
        <ActionFeedbackIcon
          icon={RefreshCw}
          feedback={refreshFeedback}
          spin
          iconClassName="size-[18px]"
        />
      </Button>
      <span className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg border border-border-button-default bg-background-primary-default shadow-xs">
        <VersionStatusSegment status={status} error={error} />
        <LifecycleButton
          status={status}
          loading={loading}
          updating={updating}
          onBegin={() => void updateFlow.begin()}
        />
      </span>
      <CliUpdateDialog engine={engine} flow={updateFlow} />
    </div>
  );
}

/** Left pill segment: probe state — checking / failed / not installed / version. */
function VersionStatusSegment({
  status,
  error,
}: {
  status: CliVersionStatus | null;
  error: string | null;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 px-2.5 text-[13px]",
        status === null && error
          ? "bg-background-tertiary-warning text-text-warning-primary"
          : "bg-background-tertiary-default text-text-secondary",
      )}
    >
      <VersionStatusLabel status={status} error={error} />
    </span>
  );
}

function VersionStatusLabel({
  status,
  error,
}: {
  status: CliVersionStatus | null;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (status === null) {
    return <>{error ? t("settings.cliVersionCheckFailed") : t("settings.cliVersionChecking")}</>;
  }
  if (!status.installed) return <>{t("settings.cliVersionNotInstalled")}</>;
  if (!status.localVersion) return null;
  return (
    <>
      <VersionStatusIcon status={status} />
      {t("settings.cliVersionLabel", { version: status.localVersion })}
    </>
  );
}

/** ↑ when an update exists, ✓ when the local version matches the registry. */
function VersionStatusIcon({ status }: { status: CliVersionStatus }) {
  const { t } = useTranslation();
  if (status.updateAvailable) {
    return <ArrowUp className="size-3.5 text-text-warning-primary" aria-hidden />;
  }
  if (status.latestVersion) {
    return (
      <Check
        className="size-3.5 text-state-success-text"
        aria-label={t("settings.cliVersionUpToDate")}
      />
    );
  }
  return null;
}

/** Right pill segment: the install/update CTA naming the target version. */
function LifecycleButton({
  status,
  loading,
  updating,
  onBegin,
}: {
  status: CliVersionStatus | null;
  loading: boolean;
  updating: boolean;
  onBegin: () => void;
}) {
  // No lifecycle action when the engine has no install channel (grok), and
  // no segment while the status is still unknown or nothing needs doing.
  if (status === null || status.updateKind === null) return null;
  if (status.installed && !status.updateAvailable) return null;
  return (
    <button
      type="button"
      className={cx(
        "inline-flex cursor-pointer items-center gap-1 px-2.5 text-[13px] font-medium",
        "bg-button-primary text-text-white",
        "disabled:cursor-not-allowed disabled:text-button-primary-disabled-foreground",
      )}
      disabled={updating || loading}
      onClick={onBegin}
    >
      <LifecycleContent status={status} updating={updating} />
    </button>
  );
}

function LifecycleContent({ status, updating }: { status: CliVersionStatus; updating: boolean }) {
  const { t } = useTranslation();
  if (updating) return <>{t("settings.cliUpdating")}</>;
  return (
    <>
      {status.installed ? (
        <ArrowUp className="size-3.5" aria-hidden />
      ) : (
        <Download className="size-3.5" aria-hidden />
      )}
      {status.installed
        ? t("settings.cliUpdateTo", { version: status.latestVersion ?? "" })
        : t("settings.cliInstall")}
    </>
  );
}
