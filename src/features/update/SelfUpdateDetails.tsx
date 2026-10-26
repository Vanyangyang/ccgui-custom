import { useTranslation } from "react-i18next";
import { deriveSelfUpdateProgress, deriveSelfUpdateResult, formatLiveUpdateBlocker } from "./SelfUpdateStatusChip";
import type { LiveUpdateChannelChange, LiveUpdateState } from "./live-update";

function Changes({ title, changes }: { title: string; changes: LiveUpdateChannelChange[] }) {
  return <section className="min-w-0 space-y-2">
    <h4 className="text-body-2-medium text-text-primary">{title}</h4>
    <ul className="space-y-2">
      {changes.map(change => <li key={change.id} className="min-w-0 rounded-lg bg-background-secondary p-3">
        <p className="break-words whitespace-pre-wrap text-body-2-regular text-text-primary">{change.summary}</p>
        <p className="mt-1 break-all text-caption-1-regular text-text-tertiary">{change.changeId}</p>
      </li>)}
    </ul>
  </section>;
}

/** Uses the app's existing status subscription; inspecting content never
 * submits an update, adds polling, or reads user conversation/checkpoint data. */
export function SelfUpdateDetails({ state }: { state: LiveUpdateState }) {
  const { t } = useTranslation();
  if (state.support !== "supported") return null;
  const batch = state.channel?.batch;
  const ready = state.channel?.ready ?? [];
  const working = state.channel?.working ?? [];
  const request = state.channel?.updateRequest;
  const progress = deriveSelfUpdateProgress(state, t);
  const result = deriveSelfUpdateResult(state, t);
  // A previous transaction may remain in native state while a new batch builds.
  const transaction = !batch || (batch.transactionId === state.transaction?.id
    && batch.manifestSha256 === state.transaction?.candidate.manifestSha256) ? state.transaction : null;
  const identity = batch?.manifestSha256 ?? transaction?.candidate.manifestSha256;
  const error = batch?.error || transaction?.failureReason;

  return <div className="flex min-w-0 flex-col gap-4" data-testid="self-update-details">
    <div className="space-y-1">
      <p role="status" className="text-body-2-medium text-text-primary">
        {state.requesting ? t("statusbar.selfUpdateRequesting") : progress?.label ?? t("statusbar.selfUpdateEmpty")}
      </p>
      {state.active && <p className="break-all text-body-2-regular text-text-secondary">
        {t("settings.liveUpdateActiveVersion", { version: state.active.version, release: state.active.releaseId })}
      </p>}
      {result?.kind === "unverified" && <p className="text-body-2-regular text-notification-warning">{t("settings.liveUpdateUnverifiedHint")}</p>}
    </div>
    {progress?.kind === "waiting-switch" && state.blockers.length > 0 && <section className="space-y-2" data-testid="self-update-blockers">
      <h4 className="text-body-2-medium text-text-primary">{t("settings.liveUpdateWaitingReasons")}</h4>
      <ul className="list-disc space-y-1 break-words pl-5 text-body-2-regular text-text-secondary">
        {state.blockers.map((blocker, index) => <li key={`${blocker.reason}:${blocker.runId ?? blocker.participant ?? "native"}:${index}`}>{formatLiveUpdateBlocker(t, blocker)}</li>)}
      </ul>
    </section>}
    {batch && <div className="space-y-2" data-testid="self-update-batch">
      <Changes title={t(result ? "settings.liveUpdateLatestChanges" : "settings.liveUpdateBatchChanges", { count: batch.changes.length })} changes={batch.changes} />
      {batch.changes.length === 0 && <p className="text-body-2-regular text-text-tertiary">{t("settings.liveUpdateNoChangeDetails")}</p>}
      {error && <p role="alert" className="break-words text-body-2-regular text-text-error-primary">{error}</p>}
    </div>}
    {request && request.waitingFor.length > 0 && <p className="break-words text-body-2-regular text-text-secondary">
      {t("settings.liveUpdateWaitingTasks", { tasks: request.waitingFor.join(", ") })}
    </p>}
    {ready.length > 0 && <Changes title={t("settings.liveUpdateReadyChanges", { count: ready.length })} changes={ready} />}
    {working.length > 0 && <Changes title={t("settings.liveUpdateWorkingChanges", { count: working.length })} changes={working} />}
    {(batch || transaction || state.active) && <details className="min-w-0 text-body-2-regular text-text-secondary">
      <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-ring">{t("settings.liveUpdateIdentifiers")}</summary>
      <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {batch && <><dt>{t("settings.liveUpdateBatchId")}</dt><dd className="break-all">{batch.id}</dd></>}
        {transaction && <><dt>{t("settings.liveUpdateTransactionId")}</dt><dd className="break-all">{transaction.id}</dd></>}
        {identity && <><dt>{t("settings.liveUpdateTargetHash")}</dt><dd className="break-all">{identity}</dd></>}
        {state.active && <><dt>{t("settings.liveUpdateActiveHash")}</dt><dd className="break-all">{state.active.manifestSha256}</dd></>}
      </dl>
    </details>}
  </div>;
}
