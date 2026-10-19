import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Archive from "lucide-react/dist/esm/icons/archive";
import ArchiveRestore from "lucide-react/dist/esm/icons/archive-restore";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import Check from "lucide-react/dist/esm/icons/check";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { requestCliMenuOpen } from "@/components/application/ai-chat/cli-menu";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { useChatStore, type ActiveSession } from "../store";
import { useHandoffStore } from "../session-cleanup";
import { HandoffCompressionControls } from "./HandoffCompressionControls";

export function HandoffOverlayCard({
  active,
  model,
}: {
  active: ActiveSession | null;
  model?: string;
}) {
  const { t } = useTranslation();
  const workspacePath = active?.sessionId === null ? active.workspacePath : "";
  const entry = useHandoffStore((s) =>
    workspacePath ? s.byWorkspace[workspacePath] : undefined,
  );
  const retryGrok = useHandoffStore((s) => s.retryGrok);
  const setArchiveSourceOnSend = useHandoffStore((s) => s.setArchiveSourceOnSend);
  const archiveSourceNow = useHandoffStore((s) => s.archiveSourceNow);
  const restoreSourceNow = useHandoffStore((s) => s.restoreSourceNow);
  const dismissHandoff = useHandoffStore((s) => s.dismissHandoff);
  const activeEngine = useChatStore((s) => s.activeEngine);

  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!entry || entry.mode !== "grok" || entry.grokStatus !== "running" || !entry.grokStartedAt) {
      setElapsedMs(0);
      return;
    }
    const start = entry.grokStartedAt;
    setElapsedMs(Math.max(0, Date.now() - start));
    const timer = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - start));
    }, 200);
    return () => window.clearInterval(timer);
  }, [entry?.id, entry?.mode, entry?.grokStatus, entry?.grokStartedAt]);

  if (!active || active.sessionId !== null || !entry) return null;

  const targetEngine = active.engine || activeEngine || entry.sourceEngine;
  const sourceEngineName = CLI_DISPLAY_NAMES[entry.sourceEngine] ?? entry.sourceEngine;
  const targetEngineName = CLI_DISPLAY_NAMES[targetEngine] ?? targetEngine;
  const shortId = entry.sourceSessionId.slice(0, 8);
  const doneSeconds =
    entry.grokDurationMs != null
      ? Math.max(0.1, entry.grokDurationMs / 1000).toFixed(1)
      : null;
  const runningSeconds = (elapsedMs / 1000).toFixed(1);

  const handleViewSource = async () => {
    if (entry.sourceArchived) {
      await restoreSourceNow(workspacePath);
      if (useHandoffStore.getState().byWorkspace[workspacePath]?.sourceArchived) return;
    }
    void useChatStore
      .getState()
      .selectSession(entry.sourceEngine, entry.sourceSessionId, entry.workspacePath);
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <section
        data-testid="handoff-overlay-card"
        aria-label={t("chat.handoffBannerTitle")}
        aria-busy={entry.mode === "grok" && entry.grokStatus === "running"}
        className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2.5 shadow-xs"
      >
        {/* Top Row: Source session identity + Live model compression status + Dismiss */}
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 rounded-md bg-background-tertiary-default px-1.5 py-0.5 font-mono text-caption-1-medium text-text-secondary">
              /handoff
            </span>
            <span className="min-w-0 truncate text-body-2-medium text-text-primary">
              {t("chat.handoffFromSession", { title: entry.sourceTitle })}
            </span>
            <span className="shrink-0 rounded-sm bg-background-tertiary-default px-1.5 py-px font-mono text-caption-2-medium text-text-tertiary">
              {entry.sourceEngine}/{shortId}
            </span>
            <button
              type="button"
              data-testid="handoff-view-source-btn"
              onClick={() => void handleViewSource()}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium text-text-secondary transition-colors duration-150 hover:bg-background-primary-hover hover:text-text-primary"
            >
              <ExternalLink className="size-3" aria-hidden />
              <span>{t("chat.handoffViewSource")}</span>
            </button>
          </div>

          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
            <div
              data-testid="handoff-grok-status"
              data-grok-status={entry.grokStatus}
              className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
            >
              {entry.mode !== "grok" ? null : entry.grokStatus === "running" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-background-tertiary-warning px-2 py-0.5 text-caption-1-medium text-text-warning-primary">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  <span>
                    {t("chat.handoffGrokRunning")} ({runningSeconds}s)
                  </span>
                </span>
              ) : entry.grokStatus === "done" ? (
                <>
                  <span className="inline-flex items-center gap-1 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium text-notification-success-foreground">
                    <Check className="size-3" aria-hidden />
                    <span>
                      {t("chat.handoffGrokDone", { seconds: doneSeconds ?? "0.5" })}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="handoff-grok-retry-btn"
                    disabled={entry.sending}
                    onClick={() => retryGrok(workspacePath)}
                    title={t(entry.sending ? "chat.handoffSendingLock" : "chat.handoffGrokRetry")}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium text-text-tertiary transition-colors duration-150 hover:bg-background-primary-hover hover:text-text-primary"
                  >
                    <RefreshCw className="size-3" aria-hidden />
                    <span>{t("chat.handoffGrokRetry")}</span>
                  </button>
                </>
              ) : entry.grokStatus === "error" ? (
                <>
                  <span
                    title={entry.grokError ?? undefined}
                    className="inline-flex items-center gap-1 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-regular text-text-tertiary"
                  >
                    <span>{t("chat.handoffGrokFailed")}</span>
                  </span>
                  <button
                    type="button"
                    data-testid="handoff-grok-retry-btn"
                    disabled={entry.sending}
                    title={entry.sending ? t("chat.handoffSendingLock") : undefined}
                    onClick={() => retryGrok(workspacePath)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium text-text-secondary transition-colors duration-150 hover:bg-background-primary-hover hover:text-text-primary"
                  >
                    <RefreshCw className="size-3" aria-hidden />
                    <span>{t("chat.handoffGrokRetry")}</span>
                  </button>
                </>
              ) : null}
            </div>

            <Button
              variant="ghost"
              size="xs"
              iconOnly
              leadingIcon={X}
              aria-label={t("chat.handoffDismiss")}
              title={t("chat.handoffDismiss")}
              data-testid="handoff-dismiss-btn"
              onClick={() => dismissHandoff(workspacePath)}
            />
          </div>
        </header>

        {/* Bottom Row: Compression Mode Segmented Control + Takeover Engine/Model + Source Session Archive Control */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <HandoffCompressionControls
            workspacePath={workspacePath}
            mode={entry.mode}
            compressionModel={entry.compressionModel}
            compressionSelection={entry.compressionSelection}
            sending={entry.sending === true}
          />
          {entry.compressionPreferenceError && (
            <p role="status" className="text-caption-1-regular text-text-warning-primary">
              {t("chat.handoffPreferenceSaveFailed")}
            </p>
          )}

          {/* Right side: Takeover Engine/Model Switcher + Archive Source Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="handoff-switch-engine-btn"
              disabled={entry.sending}
              title={entry.sending ? t("chat.handoffSendingLock") : undefined}
              onClick={() => requestCliMenuOpen()}
              className="inline-flex min-w-0 max-w-full cursor-pointer flex-wrap items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-0.5 text-caption-1-medium text-text-primary transition-colors duration-150 hover:bg-background-secondary-hover disabled:cursor-wait disabled:opacity-60"
            >
              <EngineIcon engine={entry.sourceEngine} size={13} className="shrink-0" />
              <span className="text-text-tertiary">{sourceEngineName}</span>
              <ArrowRight className="size-3 text-text-tertiary" aria-hidden />
              <EngineIcon engine={targetEngine} size={13} className="shrink-0" />
              <span>{targetEngineName}</span>
              {model && (
                <span className="max-w-32 truncate text-text-secondary">
                  · {model}
                </span>
              )}
              <span className="text-text-tertiary">
                ({t("chat.handoffSwitchEngineBtn")})
              </span>
            </button>

            {entry.sourceArchived ? (
              <button
                type="button"
                data-testid="handoff-restore-source-btn"
                onClick={() => void restoreSourceNow(workspacePath)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-0.5 text-caption-1-medium text-text-secondary transition-colors duration-150 hover:bg-background-secondary-hover hover:text-text-primary"
              >
                <ArchiveRestore className="size-3" aria-hidden />
                <span>
                  {t("chat.handoffSourceArchived")} · {t("chat.handoffRestoreSource")}
                </span>
              </button>
            ) : (
              <div className="inline-flex items-center gap-1">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption-1-regular text-text-secondary select-none hover:bg-background-primary-hover">
                  <input
                    type="checkbox"
                    data-testid="handoff-archive-on-send-checkbox"
                    checked={entry.archiveSourceOnSend}
                    onChange={(e) =>
                      setArchiveSourceOnSend(workspacePath, e.target.checked)
                    }
                    className="size-3.5 cursor-pointer rounded border-border-button-default accent-background-brand-solid-default"
                  />
                  <span>{t("chat.handoffArchiveOnSend")}</span>
                </label>
                <button
                  type="button"
                  data-testid="handoff-archive-now-btn"
                  onClick={() => void archiveSourceNow(workspacePath)}
                  title={t("chat.handoffArchiveNow")}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium text-text-tertiary transition-colors duration-150 hover:bg-background-primary-hover hover:text-text-primary"
                >
                  <Archive className="size-3" aria-hidden />
                  <span>{t("chat.handoffArchiveNow")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
