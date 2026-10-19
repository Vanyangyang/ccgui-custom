/**
 * 使用情况: two separate lists — invocation statistics (Claude Code
 * transcripts; the scope is stated, and "no data" is shown as such) and the
 * management action log.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { Button } from "@/components/base/buttons/button";
import { CenteredSpinner, EmptyState } from "@/components/base/empty-state";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { useSkillUsage } from "./useSkillUsage";
import type { SkillActivityEntry, SkillUsageResult } from "./types";
import { formatTokens } from "./utils";

const ACTION_KEYS: Record<string, string> = {
  install: "install",
  uninstall: "uninstall",
  restore: "restore",
  set_targets: "setTargets",
  import: "import",
  delete_local: "deleteLocal",
};

/** Invocation statistics (Claude Code transcripts). "No data" is kept apart
 *  from "no invocations": a scan that found no transcripts must not read as a
 *  zero-activity skill list. */
function InvocationsSection({
  usage,
  loading,
  error,
}: {
  usage: SkillUsageResult | null;
  loading: boolean;
  error: string | null;
}) {
  const { t, i18n } = useTranslation();
  const dayFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: "short",
        day: "numeric",
      }),
    [i18n.language],
  );
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-body-medium text-text-primary">{t("skills.usage.invocations")}</h3>
      <InvocationsBody usage={usage} loading={loading} error={error} dayFormat={dayFormat} />
    </section>
  );
}

function InvocationsBody({
  usage,
  loading,
  error,
  dayFormat,
}: {
  usage: SkillUsageResult | null;
  loading: boolean;
  error: string | null;
  dayFormat: Intl.DateTimeFormat;
}) {
  const { t } = useTranslation();
  // Early returns keep each branch at the top level: the table only renders
  // when there really are invocations to show.
  if (loading && !usage) {
    return <CenteredSpinner className="py-8" />;
  }
  if (error) {
    return (
      <p role="alert" className="text-body-2-regular text-text-error-primary">
        {error}
      </p>
    );
  }
  if (!usage || usage.scannedFiles === 0) {
    return (
      <EmptyState className="py-8">
        <p className="text-body-2-regular">{t("skills.usage.noData")}</p>
      </EmptyState>
    );
  }
  if (usage.skills.length === 0) {
    return (
      <EmptyState className="py-8">
        <p className="text-body-2-regular">{t("skills.usage.noInvocations")}</p>
      </EmptyState>
    );
  }
  return (
    <>
      <p className="text-caption-1-regular text-text-tertiary">
        {t("skills.usage.summary", {
          files: usage.scannedFiles,
          total: usage.totalInvocations,
        })}
        {usage.cached ? ` · ${t("skills.discover.cached")}` : ""}
      </p>
      <table className="w-full table-fixed text-body-2-regular">
        <thead>
          <tr className="text-left text-caption-1-regular text-text-tertiary">
            <th className="w-1/2 py-1 font-normal">{t("skills.usage.skill")}</th>
            <th className="w-1/6 py-1 text-right font-normal">{t("skills.usage.calls")}</th>
            <th className="w-1/6 py-1 text-right font-normal">{t("skills.usage.tokens")}</th>
            <th className="w-1/6 py-1 text-right font-normal">{t("skills.usage.lastUsed")}</th>
          </tr>
        </thead>
        <tbody>
          {usage.skills.map((entry) => (
            <tr key={entry.skill} className="border-t border-separator-border">
              <td className="truncate py-1.5 pr-2 text-text-primary" title={entry.skill}>
                {entry.skill}
              </td>
              <td className="py-1.5 text-right tabular-nums text-text-secondary">
                {entry.invocations}
              </td>
              <td className="py-1.5 text-right tabular-nums text-text-secondary">
                {formatTokens(entry.tokens?.total_tokens)}
              </td>
              <td className="py-1.5 text-right text-text-tertiary">
                {entry.lastUsedAt ? dayFormat.format(new Date(entry.lastUsedAt)) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {usage.unusedInstalled.length > 0 ? (
        <p className="text-caption-1-regular text-text-tertiary">
          {t("skills.usage.unused", { count: usage.unusedInstalled.length })}
        </p>
      ) : null}
    </>
  );
}

/** Management action log (install / uninstall / restore / import …). */
function ActivitySection({
  activity,
  loading,
  error,
}: {
  activity: SkillActivityEntry[];
  loading: boolean;
  error: string | null;
}) {
  const { t, i18n } = useTranslation();
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [i18n.language],
  );
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-body-medium text-text-primary">{t("skills.activity.title")}</h3>
      <p className="text-caption-1-regular text-text-tertiary">{t("skills.activity.scope")}</p>
      {loading && activity.length === 0 ? (
        <CenteredSpinner className="py-6" />
      ) : error ? (
        <p role="alert" className="text-body-2-regular text-text-error-primary">
          {error}
        </p>
      ) : activity.length === 0 ? (
        <EmptyState className="py-6">
          <p className="text-body-2-regular">{t("skills.activity.empty")}</p>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-1">
          {activity.map((entry) => (
            <li
              key={`${entry.ts}-${entry.action}-${entry.directory ?? ""}-${entry.name ?? ""}`}
              className="flex items-center justify-between gap-2 rounded-2lg border border-separator-border px-3 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded-full bg-background-tertiary-default px-1.5 py-0.5 text-[10px] text-text-secondary">
                  {t(`skills.activity.action.${ACTION_KEYS[entry.action] ?? "other"}`)}
                </span>
                <span className="truncate text-body-2-regular text-text-primary">
                  {entry.name || entry.directory || ""}
                </span>
              </span>
              <span className="shrink-0 text-caption-1-regular text-text-tertiary">
                {timeFormat.format(new Date(entry.ts))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SkillUsagePane() {
  const { t } = useTranslation();
  const usage = useSkillUsage(true);
  const refreshAction = useActionFeedback({ spin: true });

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption-1-regular text-text-tertiary">
          {t("skills.usage.scope")}
        </p>
        <Button
          variant="secondary"
          size="small"
          disabled={usage.usageLoading || refreshAction.feedback === "running"}
          onClick={() => {
            if (refreshAction.feedback === "running") return;
            void refreshAction.start(() => usage.refresh(true)).catch(() => undefined);
          }}
        >
          <ActionFeedbackIcon icon={RefreshCw} feedback={refreshAction.feedback} spin />
          {t("common.refresh")}
        </Button>
      </div>

      <InvocationsSection
        usage={usage.usage}
        loading={usage.usageLoading}
        error={usage.usageError}
      />
      <ActivitySection
        activity={usage.activity}
        loading={usage.activityLoading}
        error={usage.activityError}
      />
    </div>
  );
}
