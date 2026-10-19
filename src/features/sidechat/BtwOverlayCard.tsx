import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import CornerDownLeft from "lucide-react/dist/esm/icons/corner-down-left";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Square from "lucide-react/dist/esm/icons/square";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { useCopied } from "@/hooks/use-copied";
import { useSidechatStore } from "./store";
import { CacheHitBadge, SideMarkdown, SideThinking, SideToolPills } from "./side-parts";
import { insertSideAnswer } from "./insert-answer";
import { MessageImages } from "@/features/chat/components/MessageImages";
import { SideRunStatus } from "./SideRunStatus";

/**
 * `/btw` ephemeral side-question card, docked directly above the composer.
 * One question, one read-only answer: it never enters the main transcript, the
 * temporary fork is removed when the card is dismissed, and it keeps working
 * while the main conversation streams.
 */
export function BtwOverlayCard({ sessionKey }: { sessionKey: string }) {
  const { t } = useTranslation();
  const btw = useSidechatStore((s) => (sessionKey ? s.btwBySession[sessionKey] : undefined));
  const sidechatRunning = useSidechatStore((s) => s.sidechatBySession[sessionKey]?.streaming === true);
  const dismissBtw = useSidechatStore((s) => s.dismissBtw);
  const stopBtw = useSidechatStore((s) => s.stopBtw);
  const continueBtwInSidechat = useSidechatStore((s) => s.continueBtwInSidechat);
  const { copied, copy } = useCopied();
  const cardRef = useRef<HTMLDivElement>(null);
  const hasCard = Boolean(btw);
  const runId = btw?.runId;

  // A new question replaces the card; bring it into view without stealing the
  // composer's focus.
  useEffect(() => {
    if (!hasCard) return;
    cardRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [hasCard, runId]);

  // Escape dismisses when focus is nowhere in particular; inside the card the
  // section's own handler covers it, and a focused composer/menu keeps Escape.
  useEffect(() => {
    if (!hasCard) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el && el !== document.body) return;
      useSidechatStore.getState().dismissBtw(sessionKey);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasCard, sessionKey]);

  if (!btw) return null;

  const dismiss = () => dismissBtw(sessionKey);
  const durationSeconds = btw.durationMs != null ? Math.max(0.1, btw.durationMs / 1000) : null;
  const hasAnswer = btw.answer.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <section
        ref={cardRef}
        tabIndex={-1}
        aria-label={t("sidechat.btwTitle")}
        aria-busy={btw.streaming}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            dismiss();
          }
        }}
        className="flex max-h-[min(24rem,45dvh)] min-w-0 flex-col gap-2 overflow-hidden rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2.5 shadow-xs outline-none"
      >
        <header className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 rounded-md bg-background-tertiary-default px-1.5 py-0.5 font-mono text-caption-1-medium text-text-secondary">
            /btw
          </span>
          <p className="min-w-0 flex-1 break-words text-body-medium text-text-primary">
            {btw.question}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {btw.streaming ? (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  leadingIcon={Square}
                  onClick={() => void stopBtw(sessionKey)}
                >
                  {t("sidechat.stop")}
                </Button>
              </>
            ) : durationSeconds != null ? (
              <span className="text-caption-1-medium whitespace-nowrap text-text-tertiary">
                {t("sidechat.duration", { seconds: durationSeconds.toFixed(1) })}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              leadingIcon={X}
              aria-label={t("sidechat.dismiss")}
              title={t("sidechat.dismissHint")}
              onClick={dismiss}
            />
          </div>
        </header>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption-1-medium text-text-tertiary">
          <span>{t("sidechat.readOnly")}</span>
          <CacheHitBadge cacheRead={btw.usage?.cacheRead} />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
          {btw.images && btw.images.length > 0 && <MessageImages images={btw.images} />}
          <SideThinking text={btw.thinking} streaming={btw.streaming && !hasAnswer} />
          <SideToolPills tools={btw.tools} />
          {btw.error ? (
            <div
              role="alert"
              className="whitespace-pre-wrap break-words rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary"
            >
              {btw.error}
            </div>
          ) : hasAnswer ? (
            <SideMarkdown text={btw.answer} workspacePath={btw.workspacePath} streaming={btw.streaming} />
          ) : !btw.streaming ? (
            <p className="text-body-regular text-text-tertiary">{t("sidechat.noAnswer")}</p>
          ) : null}
          {btw.streaming && <SideRunStatus key={btw.runId} startedAt={btw.startedAt} progress={btw.progress} />}
        </div>

        {!btw.streaming && (
          <footer className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {hasAnswer && (
              <>
              <Button
                variant="ghost"
                size="xs"
                leadingIcon={copied ? Check : Copy}
                aria-label={copied ? t("common.copied") : t("sidechat.copyAnswer")}
                onClick={() => copy(btw.answer)}
              >
                {copied ? t("common.copied") : t("sidechat.copyAnswer")}
              </Button>
              <Button variant="ghost" size="xs" leadingIcon={CornerDownLeft}
                onClick={() => insertSideAnswer(sessionKey, btw.answer)}>
                {t("sidechat.insertAnswer")}
              </Button>
              </>
            )}
            <Button
              variant="secondary"
              size="xs"
              leadingIcon={GitBranch}
              disabled={sidechatRunning}
              onClick={() => continueBtwInSidechat(sessionKey)}
            >
              {t("sidechat.continueInSidechat")}
            </Button>
          </footer>
        )}
      </section>
    </div>
  );
}
