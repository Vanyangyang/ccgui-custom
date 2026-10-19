import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import type { SideRunProgress } from "./progress";

export const SIDE_RUN_QUIET_MS = 60_000;

/** Time is presentation only. Only engine events can advance run progress. */
export const SideRunStatus = memo(function SideRunStatus({
  startedAt,
  progress,
}: {
  startedAt: number | null;
  progress?: SideRunProgress;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const phase = progress?.phase ?? "starting";
  const lastEventAt = progress?.lastEventAt ?? null;
  const since = lastEventAt ?? startedAt;
  const quietMs = since == null ? 0 : Math.max(0, now - since);
  const quiet = quietMs >= SIDE_RUN_QUIET_MS;
  const needsAction = phase === "waiting_user";
  const seconds = Math.floor(quietMs / 1000);

  return (
    <div className="min-w-0 space-y-1.5" data-side-run-status data-quiet={quiet}>
      <AgentThinking
        variant="wave"
        label={t(`sidechat.progress.${phase}`)}
        startedAt={startedAt ?? undefined}
        showTimer={startedAt != null}
        durationFormatter={(duration) => t("chat.metaDuration", { duration })}
        attention={needsAction ? t("sidechat.progress.needsAction") : quiet ? t("sidechat.progress.quiet") : null}
        className="flex-wrap gap-y-1"
      />
      {phase === "tool" && progress?.toolName && (
        <p className="break-words text-caption-1-medium text-text-secondary [overflow-wrap:anywhere]">
          {progress.toolName}
        </p>
      )}
      <p aria-live="off" className="text-caption-1-regular text-text-tertiary">
        {lastEventAt == null
          ? t("sidechat.progress.noActivity")
          : t("sidechat.progress.lastActivity", { seconds })}
      </p>
      {progress?.detail && (
        <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-caption-1-regular text-text-secondary [overflow-wrap:anywhere]">
          {progress.detail}
        </p>
      )}
      {(quiet || needsAction) && (
        <p className="text-caption-1-regular text-text-warning-primary">
          {t(needsAction ? "sidechat.progress.actionHint" : "sidechat.progress.quietHint")}
        </p>
      )}
    </div>
  );
});
