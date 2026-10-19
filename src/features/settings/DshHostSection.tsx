import { SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import { DshConnectionCard } from "./DshConnectionCard";
import { DshHostStatusCard } from "./DshHostStatusCard";
import { useDshHost } from "./useDshHost";

/**
 * DeepSeek Harness host section, embedded in the CLI 管理 dsh page after the
 * 引擎设置 card: local host status (adopt or spawn on demand) and the
 * connection settings (custom bin path, host/port, auto-start). CLI
 * version/docs/update live in the page header (CliHeaderActions). Probes
 * run on mount and explicit user actions only — the host has no push
 * channel and polling would keep the app awake for nothing.
 */
export function DshHostSection() {
  const dsh = useDshHost();
  const { t, cliError, saveError, probeError } = dsh;

  return (
    <div className="flex w-full flex-col gap-3">
      <SettingsSectionLabel anchor="dshHost">{t("settings.dshLocalHost")}</SettingsSectionLabel>

      {cliError && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {cliError}
        </p>
      )}

      {/* Tip banner: providers/keys live in the DSH Web UI, not here. */}
      <div className="flex w-full items-start gap-2 rounded-2xl bg-background-secondary-default px-3 py-2.5">
        <span className="shrink-0 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium text-text-secondary">
          {t("settings.dshTipLabel")}
        </span>
        <p className="min-w-0 text-body-2-regular text-text-secondary">{t("settings.dshTipNote")}</p>
      </div>

      {saveError && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {saveError}
        </p>
      )}
      {probeError && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {probeError}
        </p>
      )}

      <DshHostStatusCard dsh={dsh} />
      <DshConnectionCard dsh={dsh} />
    </div>
  );
}
