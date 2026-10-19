import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Download from "lucide-react/dist/esm/icons/download";
import Check from "lucide-react/dist/esm/icons/check";
import List from "lucide-react/dist/esm/icons/list";
import {
  canRequestSelfUpdate,
  useLiveUpdateStore,
  type LiveUpdateBlocker,
  type LiveUpdateState,
} from "./live-update";
import { cx } from "@/utils/cx";

export const LIVE_UPDATE_BLOCKER_KEYS: Record<string, string> = {
  "legacy-runs": "legacyRuns",
  "terminal-sessions": "terminals",
  "terminal-opening": "terminals",
  "plugin-processes": "pluginProcesses",
  "worktree-creation": "worktree",
  "auto-title-pending": "autoTitle",
  "worker-unavailable": "workerUnavailable",
  "worker-journal-fault": "workerJournal",
  "schema-incompatible": "schema",
  "frontend-not-ready": "frontend",
  "unsaved-editor-drafts": "editorDrafts",
  "file-read-in-progress": "fileRead",
  "plugin-view-without-checkpoint": "pluginView",
  "layout-resize-in-progress": "layout",
  "participant-unavailable": "frontend",
  "checkpoint-not-restored": "frontend",
  "not-initialized": "frontend",
  "session-preparing": "session",
  "approval-submitting": "approval",
  "question-editor-handoff-pending": "question",
  "open-dialog": "dialog",
  "plugin-install-in-progress": "pluginInstall",
  "plugin-loading": "pluginLoading",
  chat: "chatOperation",
};

export function formatLiveUpdateBlocker(t: TFunction, blocker: LiveUpdateBlocker): string {
  const key = LIVE_UPDATE_BLOCKER_KEYS[blocker.reason.split(":", 1)[0]];
  return key
    ? t(`settings.liveUpdateBlockers.${key}`)
    : t("settings.liveUpdateUnknownBlocker", { reason: blocker.reason });
}

export type SelfUpdateVisualKind =
  | "waiting-tasks"
  | "building"
  | "staging"
  | "waiting-switch"
  | "switching"
  | "cancelling"
  | "error"
  | "committed"
  | "unverified"
  | "rolled-back"
  | "aborted"
  | "ready-queue";

export interface SelfUpdateProgressSummary {
  kind: SelfUpdateVisualKind;
  /** True when an active background task (build, staging, switch, waiting for tasks) is running. */
  activeTask: boolean;
  /** True when the icon should spin. */
  spinning: boolean;
  /** Compact one-line text for the bottom-right status bar chip. */
  label: string;
  /** Multi-line detail tooltip. */
  tooltip: string;
  /** Key identifying the current active phase for elapsed time tracking. */
  phaseTimerKey: string | null;
}

type SelfUpdateStateSlice = Pick<
  LiveUpdateState,
  "support" | "stage" | "active" | "transaction" | "channel" | "blockers" | "errorCode" | "error" | "recoveryError"
>;

/** A terminal batch stays inspectable after reconnect. A build or an old
 * committed transaction cannot prove that the latest batch is running. */
export function deriveSelfUpdateResult(state: SelfUpdateStateSlice, t: TFunction): SelfUpdateProgressSummary | null {
  const batch = state.channel?.batch;
  const transaction = state.transaction;
  const phase = batch?.phase ?? transaction?.phase;
  if (!phase || !["Committed", "RolledBack", "Failed", "Aborted"].includes(phase)) return null;
  const matchesBatch = !batch || (!!transaction && batch.transactionId === transaction.id
    && batch.manifestSha256 === transaction.candidate.manifestSha256);
  const committed = phase === "Committed" && transaction?.phase === "Committed" && matchesBatch
    && /^[a-f0-9]{64}$/.test(transaction.candidate.manifestSha256)
    && state.active?.manifestSha256 === transaction.candidate.manifestSha256;
  const kind = phase === "Committed" ? committed ? "committed" : "unverified"
    : phase === "RolledBack" ? "rolled-back" : phase === "Aborted" ? "aborted" : "error";
  const label = t(`statusbar.${kind === "committed" ? "selfUpdateCommitted" : kind === "unverified" ? "selfUpdateUnverified"
    : kind === "rolled-back" ? "selfUpdateRolledBack" : kind === "aborted" ? "selfUpdateAborted" : "selfUpdateFailed"}`);
  const lines = [label];
  if (state.active) lines.push(t("settings.liveUpdateActiveVersion", { version: state.active.version, release: state.active.releaseId }));
  if (transaction && matchesBatch) lines.push(t("settings.liveUpdateTargetVersion", { version: transaction.candidate.version, release: transaction.candidate.releaseId }));
  const reason = batch?.error || (matchesBatch ? transaction?.failureReason : undefined);
  if (reason) lines.push(reason);
  for (const change of batch?.changes.slice(0, 6) ?? []) lines.push(`• ${change.changeId}: ${change.summary}`);
  lines.push(t("statusbar.selfUpdateOpenSettings"));
  return { kind, label, tooltip: lines.join("\n"), activeTask: false, spinning: false, phaseTimerKey: null };
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}:${String(secs).padStart(2, "0")}` : `${secs}s`;
}

export function deriveSelfUpdateProgress(
  state: SelfUpdateStateSlice,
  t: TFunction,
): SelfUpdateProgressSummary | null {
  if (state.support === "web" || state.support === "not-custom" || state.support === "unsupported") {
    return null;
  }

  const channel = state.channel;
  const batch = channel?.batch ?? null;
  const updateRequest = channel?.updateRequest ?? null;
  const readyList = channel?.ready ?? [];

  const detailLines: string[] = [];
  const appendChanges = (changes: Array<{ changeId: string; summary: string }>) => {
    for (const item of changes.slice(0, 6)) {
      detailLines.push(`• ${item.changeId}: ${item.summary}`);
    }
  };

  // 1. Active switching / handoff
  if (state.stage === "applying" || state.stage === "handoff" || state.transaction?.phase === "Activating") {
    const label = t("statusbar.selfUpdateSwitching");
    detailLines.push(
      state.stage === "handoff" ? t("settings.liveUpdateHandoff") : t("settings.liveUpdateApplying"),
    );
    if (state.transaction) {
      detailLines.push(
        t("settings.liveUpdateCandidate", {
          version: state.transaction.candidate.version,
          release: state.transaction.candidate.releaseId,
        }),
      );
    }
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "switching",
      activeTask: true,
      spinning: true,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: `switching:${state.transaction?.id ?? "active"}`,
    };
  }

  // 2. Cancelling
  if (state.stage === "cancelling") {
    const label = t("statusbar.selfUpdateCancelling");
    detailLines.push(t("settings.liveUpdateCancelling"));
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "cancelling",
      activeTask: true,
      spinning: true,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: "cancelling",
    };
  }

  // 3. Importing or native Staging
  if (state.stage === "importing" || batch?.phase === "Staging") {
    const label = t("statusbar.selfUpdateStaging");
    detailLines.push(t("settings.liveUpdateImporting"));
    if (batch?.changes?.length) {
      appendChanges(batch.changes);
    }
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "staging",
      activeTask: true,
      spinning: true,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: `staging:${batch?.id ?? "manual"}`,
    };
  }

  // 4. Waiting for safe switch boundary (staged candidate)
  const pendingTx =
    state.stage === "waiting" ||
    state.transaction?.phase === "Preparing" ||
    state.transaction?.phase === "Ready";
  if (pendingTx && !state.errorCode) {
    const blockerCount = state.blockers.length;
    const baseLabel = t("statusbar.selfUpdateWaitingSwitch");
    const label = blockerCount > 0 ? `${baseLabel} (${blockerCount})` : baseLabel;
    detailLines.push(t("settings.liveUpdateWaiting"));
    if (state.transaction) {
      detailLines.push(
        t("settings.liveUpdateCandidate", {
          version: state.transaction.candidate.version,
          release: state.transaction.candidate.releaseId,
        }),
      );
    }
    if (blockerCount > 0) {
      detailLines.push(t("settings.liveUpdateWaitingReasons"));
      for (const blocker of state.blockers) {
        detailLines.push(`• ${formatLiveUpdateBlocker(t, blocker)}`);
      }
    }
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "waiting-switch",
      activeTask: true,
      spinning: blockerCount === 0,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: `waiting-switch:${state.transaction?.id ?? "staged"}`,
    };
  }

  // 5. Background snapshot build in progress
  if (batch?.phase === "Building") {
    const count = batch.changes.length;
    const label = t("statusbar.selfUpdateBuilding", { count });
    detailLines.push(t("settings.liveUpdateBuilding", { count }));
    appendChanges(batch.changes);
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "building",
      activeTask: true,
      spinning: true,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: `building:${batch.id}`,
    };
  }

  // 6. Waiting for in-progress working tasks before freezing the batch
  if (updateRequest) {
    const waitingCount = updateRequest.waitingFor.length;
    const total = Math.max(updateRequest.targetChangeIds.length, waitingCount);
    const done = Math.max(0, total - waitingCount);
    const label = waitingCount > 0 ? t("statusbar.selfUpdateWaitingTasks", { done, total }) : t("statusbar.selfUpdateRequested");
    detailLines.push(waitingCount > 0
      ? t("settings.liveUpdateWaitingTasks", {
        tasks: updateRequest.waitingFor.join(", "),
      }) : label,
    );
    if (readyList.length > 0) {
      appendChanges(readyList);
    }
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "waiting-tasks",
      activeTask: true,
      spinning: true,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: `waiting-tasks:${updateRequest.id}`,
    };
  }

  const result = deriveSelfUpdateResult(state, t);
  if (result && (!state.errorCode || state.errorCode === "previousFailed")) return result;

  // 7. Error state (stage error or failed batch)
  if (state.stage === "error" || state.errorCode || batch?.phase === "Failed") {
    const label = t("statusbar.selfUpdateFailed");
    if (state.errorCode) {
      detailLines.push(t(`settings.liveUpdateErrors.${state.errorCode}`));
    }
    const errText = state.error || batch?.error || state.recoveryError;
    if (errText) {
      detailLines.push(errText);
    }
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "error",
      activeTask: false,
      spinning: false,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: null,
    };
  }

  // 8. Queued ready changes waiting for user to trigger self-update
  if (readyList.length > 0) {
    const count = readyList.length;
    const label = t("statusbar.selfUpdateReadyQueue", { count });
    detailLines.push(t("settings.liveUpdateReadyCount", { count }));
    appendChanges(readyList);
    detailLines.push(t("statusbar.selfUpdateOpenSettings"));
    return {
      kind: "ready-queue",
      activeTask: false,
      spinning: false,
      label,
      tooltip: detailLines.join("\n"),
      phaseTimerKey: null,
    };
  }

  return null;
}

/**
 * Renders live self-update progress and stage right beside the bottom-right
 * version chip. Idle clicks request the registered changes; active clicks open details.
 */
export function SelfUpdateStatusChip() {
  const { t } = useTranslation();
  const support = useLiveUpdateStore((s) => s.support);
  const stage = useLiveUpdateStore((s) => s.stage);
  const active = useLiveUpdateStore((s) => s.active);
  const transaction = useLiveUpdateStore((s) => s.transaction);
  const channel = useLiveUpdateStore((s) => s.channel);
  const blockers = useLiveUpdateStore((s) => s.blockers);
  const errorCode = useLiveUpdateStore((s) => s.errorCode);
  const error = useLiveUpdateStore((s) => s.error);
  const recoveryError = useLiveUpdateStore((s) => s.recoveryError);
  const requesting = useLiveUpdateStore((s) => s.requesting);
  const requestError = useLiveUpdateStore((s) => s.requestError);
  const canRequest = useLiveUpdateStore(canRequestSelfUpdate);

  const summary = deriveSelfUpdateProgress(
    { support, stage, active, transaction, channel, blockers, errorCode, error, recoveryError },
    t,
  );

  const phaseKey = summary?.phaseTimerKey ?? null;
  const startedAtRef = useRef<{ key: string; at: number } | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!phaseKey) {
      startedAtRef.current = null;
      setElapsedSec(0);
      return;
    }
    if (startedAtRef.current?.key !== phaseKey) {
      startedAtRef.current = { key: phaseKey, at: Date.now() };
      setElapsedSec(0);
    }
    const tick = () => {
      if (document.hidden || !startedAtRef.current) return;
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAtRef.current.at) / 1000)));
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phaseKey]);

  if (support !== "supported") return null;

  const visibleRequestError = summary?.activeTask ? undefined : requestError;
  const isError = !requesting && (!!visibleRequestError || summary?.kind === "error" || summary?.kind === "rolled-back");
  const isWaitingBlocked = (summary?.kind === "waiting-switch" && !summary.spinning) || summary?.kind === "unverified";
  const isReadyQueue = summary?.kind === "ready-queue";
  const count = (channel?.ready.length ?? 0) + (channel?.working?.length ?? 0);
  const label = requesting ? t("statusbar.selfUpdateRequesting")
    : visibleRequestError ? t("statusbar.selfUpdateRequestFailed")
      : canRequest ? t("statusbar.selfUpdateActionCount", { count })
        : summary?.label ?? t("statusbar.selfUpdateAction");
  const tooltip = requesting ? t("statusbar.selfUpdateRequesting")
    : canRequest ? [visibleRequestError, t("statusbar.selfUpdateRequestHint"),
        ...(channel?.ready ?? []).map((change) => `• ${change.changeId}: ${change.summary}`),
        ...(channel?.working ?? []).map((change) => `• ${change.changeId}: ${change.summary}`),
      ].filter(Boolean).join("\n")
      : [visibleRequestError, summary?.tooltip ?? t("statusbar.selfUpdateEmpty")].filter(Boolean).join("\n");
  const disabled = requesting || (!canRequest && !summary && !requestError);
  const spinning = requesting || summary?.spinning;
  const showElapsed =
    summary?.activeTask &&
    (summary.kind === "building" ||
      summary.kind === "staging" ||
      summary.kind === "waiting-tasks") &&
    elapsedSec > 0;

  return (
    <>
          <span className="text-text-disabled">·</span>
          <button
            type="button"
            data-testid="statusbar-self-update-chip"
            data-onboarding-target="self-update-status"
            data-self-update-kind={requesting ? "requesting" : visibleRequestError ? "request-error" : summary?.kind ?? "idle"}
            aria-label={label}
            aria-busy={requesting || summary?.activeTask || undefined}
            disabled={disabled}
            title={tooltip}
            onClick={() => {
              if (canRequest) void useLiveUpdateStore.getState().requestUpdate();
              else window.location.hash = "#/settings?page=update";
            }}
            className={cx(
              "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-px transition-colors duration-150 hover:bg-background-tertiary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-ring disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none",
              isError
                ? "text-text-error-primary"
                : isWaitingBlocked
                  ? "text-notification-warning"
                  : summary?.activeTask
                    ? "bg-background-secondary text-text-primary"
                    : "text-text-secondary",
            )}
          >
            {spinning && (
              <Loader2
                className="size-3 shrink-0 animate-spin text-foreground-icon-secondary motion-reduce:animate-none"
                aria-hidden
              />
            )}
            {!spinning && !isError && !isWaitingBlocked && (summary?.kind === "committed" && !canRequest
              ? <Check className="size-3 shrink-0" aria-hidden /> : <Download className="size-3 shrink-0" aria-hidden />)}
            {isWaitingBlocked && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-notification-warning"
                aria-hidden
              />
            )}
            {isError && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-notification-error"
                aria-hidden
              />
            )}
            {isReadyQueue && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-brand-primary"
                aria-hidden
              />
            )}
            <span className="whitespace-nowrap">{label}</span>
            {showElapsed && (
              <span className="tabular-nums text-text-tertiary">
                {formatElapsed(elapsedSec)}
              </span>
            )}
          </button>
          {canRequest && <button
            type="button"
            data-testid="statusbar-self-update-details"
            data-onboarding-target="self-update-details"
            aria-label={t("statusbar.selfUpdateDetails")}
            title={t("statusbar.selfUpdateDetails")}
            onClick={() => { window.location.hash = "#/settings?page=update"; }}
            className="inline-flex shrink-0 cursor-pointer items-center rounded p-0.5 text-text-secondary transition-colors duration-150 hover:bg-background-tertiary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-ring motion-reduce:transition-none"
          ><List className="size-3" aria-hidden /></button>}
    </>
  );
}
