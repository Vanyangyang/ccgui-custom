import { useTranslation } from "react-i18next";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import Power from "lucide-react/dist/esm/icons/power";
import { Button } from "@/components/base/buttons/button";
import { useCopied } from "@/hooks/use-copied";
import { isWeb } from "@/lib/transport";
import {
  formatCrashReport,
  quitApp,
  reloadApp,
  type CrashReport,
} from "@/lib/crash";

/**
 * Full-page crash surface: the reason a broken app can't be a silent white
 * screen. Rendered by the top-level React error boundary for render crashes
 * and by CrashHost for uncaught async/global errors. `dismissible` is only
 * true for the latter — the React tree may still be usable, so "keep using"
 * is offered alongside reload.
 */
export function CrashScreen({
  report,
  dismissible = false,
  onDismiss,
}: {
  report: CrashReport;
  dismissible?: boolean;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();

  return (
    <div
      role="alert"
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-auto bg-background-primary-default p-6 text-text-primary"
    >
      <div className="flex w-full max-w-2xl flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background-tertiary-error text-text-error-primary">
            <TriangleAlert className="size-6" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-col">
            <h1 className="text-title-3-semibold">{t("crash.title")}</h1>
            <p className="text-body-medium text-text-tertiary">{t("crash.description")}</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 rounded-xl border border-separator-border bg-background-secondary-default p-4">
          <span className="text-caption-1-semibold text-text-tertiary">
            {t("crash.reasonLabel")}
          </span>
          <p className="whitespace-pre-wrap break-words font-mono text-body-medium text-text-error-primary">
            {report.message}
          </p>
        </div>

        <details className="group rounded-xl border border-separator-border">
          <summary className="cursor-pointer select-none rounded-xl px-4 py-3 text-body-medium text-text-secondary hover:bg-background-secondary-hover">
            {t("crash.details")}
          </summary>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-separator-border px-4 py-3 font-mono text-caption-1 text-text-tertiary">
            {formatCrashReport(report)}
          </pre>
        </details>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" leadingIcon={RotateCcw} onClick={reloadApp}>
            {t("crash.reload")}
          </Button>
          <Button
            variant="secondary"
            leadingIcon={copied ? Check : Copy}
            onClick={() => copy(formatCrashReport(report))}
          >
            {copied ? t("crash.copied") : t("crash.copy")}
          </Button>
          {!isWeb && (
            <Button variant="secondary" leadingIcon={Power} onClick={quitApp}>
              {t("crash.quit")}
            </Button>
          )}
          {dismissible && onDismiss && (
            <Button variant="ghost" onClick={onDismiss}>
              {t("crash.continue")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
