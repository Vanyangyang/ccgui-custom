import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Compass from "lucide-react/dist/esm/icons/compass";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import {
  ONBOARDING_STEPS_BY_TOPIC,
  ONBOARDING_TOPICS,
  useOnboardingStore,
  type OnboardingStepSpec,
  type OnboardingTopicId,
} from "./store";
import { OnboardingInteractiveDemo } from "./OnboardingInteractiveDemo";

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const BUBBLE_WIDTH = 440;
const BUBBLE_MARGIN = 16;
const SPOTLIGHT_PADDING = 6;

function findVisibleTarget(selector?: string): HTMLElement | null {
  if (!selector || typeof document === "undefined") return null;
  const parts = selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const candidates = document.querySelectorAll<HTMLElement>(part);
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 4 && rect.height > 4) {
        return el;
      }
    }
  }
  return null;
}

function computeBubblePosition(
  targetRect: SpotlightRect | null,
  bubbleHeight: number,
): { top: number; left: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const width = Math.min(BUBBLE_WIDTH, vw - BUBBLE_MARGIN * 2);
  const height = Math.max(260, bubbleHeight);

  if (!targetRect) {
    return {
      top: Math.max(BUBBLE_MARGIN, Math.round((vh - height) / 2)),
      left: Math.max(BUBBLE_MARGIN, Math.round((vw - width) / 2)),
    };
  }

  const clampLeft = (l: number) =>
    Math.min(Math.max(BUBBLE_MARGIN, Math.round(l)), Math.max(BUBBLE_MARGIN, vw - width - BUBBLE_MARGIN));
  const clampTop = (t: number) =>
    Math.min(Math.max(BUBBLE_MARGIN, Math.round(t)), Math.max(BUBBLE_MARGIN, vh - height - BUBBLE_MARGIN));

  const spaceBelow = vh - (targetRect.top + targetRect.height);
  const spaceAbove = targetRect.top;
  const spaceRight = vw - (targetRect.left + targetRect.width);
  const spaceLeft = targetRect.left;

  if (spaceBelow >= height + 20) {
    return {
      top: clampTop(targetRect.top + targetRect.height + 12),
      left: clampLeft(targetRect.left),
    };
  }
  if (spaceAbove >= height + 20) {
    return {
      top: clampTop(targetRect.top - height - 12),
      left: clampLeft(targetRect.left),
    };
  }
  if (spaceRight >= width + 20) {
    return {
      top: clampTop(targetRect.top),
      left: clampLeft(targetRect.left + targetRect.width + 12),
    };
  }
  if (spaceLeft >= width + 20) {
    return {
      top: clampTop(targetRect.top),
      left: clampLeft(targetRect.left - width - 12),
    };
  }

  return {
    top: clampTop(vh - height - 48),
    left: clampLeft((vw - width) / 2),
  };
}

/**
 * Top-bar entry pill ("功能引导") with an inline hide (×) button.
 * When hidden, the user can re-enable it in Settings → General → Appearance.
 */
export function OnboardingEntryButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const showEntry = useOnboardingStore((s) => s.showEntry);
  const openTour = useOnboardingStore((s) => s.openTour);
  const setShowEntry = useOnboardingStore((s) => s.setShowEntry);

  if (!showEntry) return null;

  return (
    <div
      data-onboarding-target="guide-entry"
      className={cx(
        "group inline-flex shrink-0 items-center rounded-lg border border-border-button-default bg-background-primary-default text-caption-1-medium text-text-secondary shadow-2xs transition-colors duration-150 hover:border-border-neutral hover:bg-background-secondary-hover hover:text-text-primary",
        className,
      )}
    >
      <button
        type="button"
        data-testid="onboarding-open-button"
        title={t("onboarding.entryTooltip")}
        aria-label={t("onboarding.entryButton")}
        onClick={() => openTour()}
        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-l-lg px-2 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <Compass className="size-3.5 shrink-0 text-accent-300" aria-hidden />
        <span className="whitespace-nowrap">{t("onboarding.entryButton")}</span>
      </button>
      <button
        type="button"
        data-testid="onboarding-hide-entry-inline"
        title={t("onboarding.hideEntryTooltip")}
        aria-label={t("onboarding.hideEntryButton")}
        onClick={(e) => {
          e.stopPropagation();
          setShowEntry(false);
        }}
        className="inline-flex h-6 w-5 cursor-pointer items-center justify-center rounded-r-lg border-l border-separator-border text-text-tertiary transition-colors duration-150 hover:bg-background-tertiary-default hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

export function OnboardingTourHost() {
  const { t } = useTranslation();
  const open = useOnboardingStore((s) => s.open);
  const topic = useOnboardingStore((s) => s.topic);
  const stepIndex = useOnboardingStore((s) => s.stepIndex);
  const showEntry = useOnboardingStore((s) => s.showEntry);
  const closeTour = useOnboardingStore((s) => s.closeTour);
  const selectTopic = useOnboardingStore((s) => s.selectTopic);
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const setShowEntry = useOnboardingStore((s) => s.setShowEntry);
  const autoStartIfFirstInstall = useOnboardingStore((s) => s.autoStartIfFirstInstall);

  const [targetRect, setTargetRect] = useState<SpotlightRect | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState(320);
  const [hiddenNotice, setHiddenNotice] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      autoStartIfFirstInstall();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [autoStartIfFirstInstall]);

  const steps = ONBOARDING_STEPS_BY_TOPIC[topic] ?? ONBOARDING_STEPS_BY_TOPIC.proxy;
  const currentStep: OnboardingStepSpec = steps[Math.min(stepIndex, steps.length - 1)] ?? steps[0];

  const measureTarget = useCallback(() => {
    if (!open) return;
    const el = findVisibleTarget(currentStep?.targetSelector);
    if (!el) {
      setTargetRect(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setTargetRect({
      top: Math.max(2, rect.top - SPOTLIGHT_PADDING),
      left: Math.max(2, rect.left - SPOTLIGHT_PADDING),
      width: rect.width + SPOTLIGHT_PADDING * 2,
      height: rect.height + SPOTLIGHT_PADDING * 2,
    });
  }, [open, currentStep]);

  useLayoutEffect(() => {
    if (!open) return;
    const chatTopics: OnboardingTopicId[] = [
      "handoff",
      "sidechat",
      "btw",
      "intelligenceUi",
    ];
    if (
      chatTopics.includes(topic) &&
      typeof window !== "undefined" &&
      window.location.hash.startsWith("#/settings")
    ) {
      window.location.hash = "#/";
    }
    measureTarget();
    const timer = window.setTimeout(measureTarget, 180);
    window.addEventListener("resize", measureTarget);
    window.addEventListener("scroll", measureTarget, true);
    window.addEventListener("hashchange", measureTarget);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", measureTarget);
      window.removeEventListener("scroll", measureTarget, true);
      window.removeEventListener("hashchange", measureTarget);
    };
  }, [open, topic, stepIndex, measureTarget]);

  useEffect(() => {
    if (!open) {
      setHiddenNotice(false);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTour();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nextStep();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevStep();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeTour, nextStep, prevStep]);

  if (!open) return null;

  const topicIdx = ONBOARDING_TOPICS.indexOf(topic);
  const isFirstOverall = topicIdx <= 0 && stepIndex <= 0;
  const isLastOverall =
    topicIdx === ONBOARDING_TOPICS.length - 1 && stepIndex >= steps.length - 1;

  const bubblePos = computeBubblePosition(targetRect, bubbleHeight);

  const handleStepAction = (action: NonNullable<OnboardingStepSpec["action"]>) => {
    if (action.kind === "openSettings") {
      window.location.hash = `#/settings?page=${encodeURIComponent(action.page)}`;
      window.setTimeout(measureTarget, 220);
      return;
    }
    if (action.kind === "closeSettings") {
      window.location.hash = "#/";
      window.setTimeout(measureTarget, 180);
    }
  };

  return createPortal(
    <div
      data-testid="onboarding-tour-overlay"
      className="fixed inset-0 z-50 overflow-hidden select-none"
      aria-live="polite"
    >
      {/* Backdrop mask: either a spotlight cutout around the target or a full backdrop */}
      {targetRect ? (
        <>
          <div
            aria-hidden
            onClick={closeTour}
            className="fixed inset-0 cursor-pointer bg-transparent"
          />
          <div
            data-testid="onboarding-spotlight-ring"
            aria-hidden
            style={{
              top: targetRect.top,
              left: targetRect.left,
              width: targetRect.width,
              height: targetRect.height,
              boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.56)",
            }}
            className="pointer-events-none fixed rounded-xl ring-2 ring-accent-300 transition-all duration-200 ease-out"
          />
        </>
      ) : (
        <div
          aria-hidden
          onClick={closeTour}
          className="fixed inset-0 cursor-pointer bg-overlay-backdrop transition-opacity duration-150"
        />
      )}

      {/* Floating Popover Bubble */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.dialogAriaLabel")}
        ref={(el) => {
          if (el) {
            const h = el.getBoundingClientRect().height;
            if (Math.abs(h - bubbleHeight) > 8) setBubbleHeight(h);
          }
        }}
        style={{
          top: bubblePos.top,
          left: bubblePos.left,
          width: Math.min(BUBBLE_WIDTH, (typeof window !== "undefined" ? window.innerWidth : 1280) - BUBBLE_MARGIN * 2),
        }}
        className="fixed z-10 flex flex-col gap-2.5 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-dropdown transition-all duration-200 ease-out"
      >
        {/* Header: Title + Close button */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-4 shrink-0 text-accent-300" aria-hidden />
            <span className="text-caption-1-medium text-text-secondary">
              {t("onboarding.hubTitle")}
            </span>
            <span className="rounded-md bg-background-secondary-default px-1.5 py-0.5 text-caption-2-medium text-text-tertiary tabular-nums">
              {topicIdx + 1} / {ONBOARDING_TOPICS.length}
            </span>
          </div>
          <button
            type="button"
            data-testid="onboarding-close-button"
            aria-label={t("onboarding.closeButton")}
            title={t("onboarding.closeButton")}
            onClick={closeTour}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-lg text-text-tertiary transition-colors duration-150 hover:bg-background-secondary-hover hover:text-text-primary"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Topic Picker Pills — user can freely choose which guide to view */}
        <div
          role="tablist"
          aria-label={t("onboarding.topicListLabel")}
          className="flex flex-wrap gap-1 border-b border-separator-border pb-2"
        >
          {ONBOARDING_TOPICS.map((item: OnboardingTopicId) => {
            const active = item === topic;
            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`onboarding-topic-${item}`}
                onClick={() => selectTopic(item)}
                className={cx(
                  "cursor-pointer rounded-lg px-2 py-0.5 text-caption-1-medium transition-colors duration-150",
                  active
                    ? "bg-button-primary text-text-white"
                    : "bg-background-secondary-default text-text-secondary hover:bg-background-tertiary-default hover:text-text-primary",
                )}
              >
                {t(`onboarding.topics.${item}`)}
              </button>
            );
          })}
        </div>

        {/* Step Content: Concise 1-line summary + visual interactive walkthrough */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-body-medium text-text-primary">
              {t(currentStep.titleKey)}
            </h3>
            {currentStep.action && (
              <Button
                size="small"
                variant="secondary"
                data-testid={`onboarding-step-action-${currentStep.id}`}
                onClick={() => handleStepAction(currentStep.action!)}
              >
                {t(currentStep.action.labelKey)}
              </Button>
            )}
          </div>
          <p className="text-caption-1-regular text-text-secondary">
            {t(currentStep.bodyKey)}
          </p>

          <OnboardingInteractiveDemo
            topic={topic}
            stepIndex={stepIndex}
          />
        </div>

        {/* Footer: Hide Top-Bar Entry & Step Navigation */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-separator-border pt-2.5">
          <div className="flex items-center gap-2">
            {showEntry ? (
              <button
                type="button"
                data-testid="onboarding-hide-entry-button"
                onClick={() => {
                  setShowEntry(false);
                  setHiddenNotice(true);
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-caption-1-regular text-text-tertiary transition-colors duration-150 hover:bg-background-secondary-hover hover:text-text-secondary"
              >
                <EyeOff className="size-3.5" aria-hidden />
                <span>{t("onboarding.hideEntryButton")}</span>
              </button>
            ) : (
              <span className="text-caption-1-regular text-text-tertiary">
                {hiddenNotice
                  ? t("onboarding.entryHiddenNotice")
                  : t("onboarding.entryReenableHint")}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="small"
              variant="ghost"
              disabled={isFirstOverall}
              onClick={prevStep}
            >
              {t("onboarding.prevButton")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              onClick={closeTour}
            >
              {t("onboarding.dismissButton")}
            </Button>
            <Button
              size="small"
              data-testid="onboarding-next-button"
              onClick={nextStep}
            >
              {isLastOverall ? t("onboarding.finishButton") : t("onboarding.nextButton")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
