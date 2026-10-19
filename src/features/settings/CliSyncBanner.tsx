import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";

/** Banner shown when the cc-switch store changed underneath us. */
export function CliSyncBanner({
  providers,
  busy,
  onSync,
  onDismiss,
}: {
  /** Number of cc-switch providers that would be synced. */
  providers: number;
  busy: boolean;
  onSync: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border-button-default bg-background-secondary-default px-4 py-2.5">
      <p className="flex items-center gap-2 text-body-regular text-text-primary">
        <RefreshCw className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span>
          {t("settings.cliSyncTitle")}
          <span className="text-text-secondary">
            {" · "}
            {t("settings.cliSyncDetail", { count: providers })}
          </span>
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onSync}
          className="rounded-lg bg-accent-500 px-3 py-1 text-body-2-medium text-white disabled:opacity-50"
        >
          {t("settings.cliSyncNow")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-border-button-default px-3 py-1 text-body-2-medium text-text-primary"
        >
          {t("settings.cliSyncLater")}
        </button>
      </div>
    </div>
  );
}
