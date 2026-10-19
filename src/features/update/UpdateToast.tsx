import { AnimatePresence, m } from "motion/react";
import { useTranslation } from "react-i18next";
import Download from "lucide-react/dist/esm/icons/download";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { downloadPercent, useUpdateStore } from "./store";
import type { UpdateStage } from "./store";
import { useUpdateStageMessage } from "./stage-message";

/** Stages that surface the toast; idle/checking/latest stay silent. */
const VISIBLE_STAGES: readonly UpdateStage[] = [
  "available",
  "downloading",
  "installing",
  "restarting",
  "error",
];

/** Dismiss affordance, offered only while the toast expects a decision
 *  (update available / error), not mid-install. */
function DismissToastButton({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={t("settings.updateDismiss")}
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
    >
      <X className="size-4" aria-hidden />
    </button>
  );
}

/** Thin download progress bar under the header while downloading. */
function DownloadProgressBar({ percent }: { percent: number | null }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-background-secondary-default">
      <div
        className="h-full rounded-full bg-button-primary transition-[width]"
        style={{ width: `${percent ?? 0}%` }}
      />
    </div>
  );
}

/** Footer actions for the stages that expect a decision: Later/Update now
 *  when available, Dismiss/Check again on error; nothing mid-install. */
function UpdateToastActions({
  stage,
  onStart,
  onDismiss,
  onRetry,
}: {
  stage: UpdateStage;
  onStart: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (stage === "available") {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button size="small" variant="secondary" onClick={onDismiss}>
          {t("settings.updateLater")}
        </Button>
        <Button size="small" variant="primary" onClick={onStart}>
          {t("settings.updateNow")}
        </Button>
      </div>
    );
  }
  if (stage === "error") {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button size="small" variant="secondary" onClick={onDismiss}>
          {t("settings.updateDismiss")}
        </Button>
        <Button size="small" variant="primary" leadingIcon={RefreshCcw} onClick={onRetry}>
          {t("settings.checkUpdates")}
        </Button>
      </div>
    );
  }
  return null;
}

/**
 * Floating update banner, mounted once in App. Auto-check failures stay
 * silent; the toast appears when an update is actually available, tracks
 * download/install, and surfaces errors from user-initiated actions.
 *
 * z-105: outranks the fullscreen page shells (settings / plugin pages,
 * z-100) so a check started inside settings can be acted on — "update
 * now" — without closing it first. Modals (z-110) stay above: they hide
 * the rest of the app from assistive tech, so a toast floating over their
 * backdrop would be clickable but unannounced.
 */
export function UpdateToast() {
  const stage = useUpdateStore((s) => s.stage);
  const version = useUpdateStore((s) => s.version);
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const totalBytes = useUpdateStore((s) => s.totalBytes);
  const error = useUpdateStore((s) => s.error);
  const startUpdate = useUpdateStore((s) => s.startUpdate);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const dismiss = useUpdateStore((s) => s.dismiss);

  const visible = VISIBLE_STAGES.includes(stage);

  const percent = downloadPercent(downloadedBytes, totalBytes);
  const message = useUpdateStageMessage({
    stage,
    version,
    downloadedBytes,
    totalBytes,
    error,
  });

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.18 }}
          role="status"
          className="fixed bottom-4 right-4 z-105 flex w-80 flex-col gap-3 rounded-2xl border border-separator-border bg-background-primary-default p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Download className="size-[18px] shrink-0 text-foreground-icon-secondary" aria-hidden />
              <p className="text-body-medium text-text-primary">{message}</p>
            </div>
            {(stage === "available" || stage === "error") && (
              <DismissToastButton onDismiss={dismiss} />
            )}
          </div>

          {stage === "downloading" && <DownloadProgressBar percent={percent} />}

          <UpdateToastActions
            stage={stage}
            onStart={() => void startUpdate()}
            onDismiss={dismiss}
            onRetry={() => void checkForUpdates({ interactive: true })}
          />
        </m.div>
      )}
    </AnimatePresence>
  );
}
