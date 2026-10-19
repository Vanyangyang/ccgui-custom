import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "@/utils/cx";

export const ERROR_BANNER_AUTO_DISMISS_MS = 5_000;

/** Keep full upstream errors scrollable without displacing the conversation. */
export function ErrorBanner({
  message,
  onDismiss,
  className,
  autoDismissMs = ERROR_BANNER_AUTO_DISMISS_MS,
}: {
  message: string | null;
  onDismiss: () => void;
  className?: string;
  autoDismissMs?: number;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) {
      setHovered(false);
      setFocused(false);
    }
  }, [message]);

  useEffect(() => {
    if (!message || hovered || focused || autoDismissMs <= 0) return;
    const timer = window.setTimeout(() => {
      onDismissRef.current();
    }, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [message, hovered, focused, autoDismissMs]);

  if (!message) return null;
  return (
    <div
      role="alert"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      className={cx(
        "flex min-w-0 shrink-0 items-start gap-2 rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary",
        className,
      )}
    >
      <span
        tabIndex={0}
        className="max-h-32 max-h-[min(8rem,12dvh)] min-w-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap break-all [@media(max-height:500px)]:max-h-6"
      >
        {message}
      </span>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-background-tertiary-hover"
      >
        ×
      </button>
    </div>
  );
}

