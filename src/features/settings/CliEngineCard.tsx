import { useTranslation } from "react-i18next";
import { Switch } from "@/components/base/switch/switch";
import { InfoTip } from "@/components/base/tooltip/tooltip";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import type { EngineId } from "./providers";
import { Badge, ROW } from "./CliChannelRow";

/** 引擎设置 card: the per-CLI enable switch. Everything below this switch
 *  (official fallback, auth, channels) lives in CliConfigBody's overlay
 *  wrapper so disabling the engine masks all of it. */
export function CliEngineCard({
  engine,
  enabled,
  busy,
  onToggleEnabled,
}: {
  engine: EngineId;
  enabled: boolean;
  busy: boolean;
  onToggleEnabled: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard>
      <div className={ROW}>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="flex items-center gap-1.5 text-body-regular text-text-primary">
            {t("settings.cliEnableTitle", { name: CLI_DISPLAY_NAMES[engine] })}
            <Badge>{t("settings.cliEngineSection")}</Badge>
            <InfoTip label={t("settings.cliEnableDesc")} />
          </p>
        </div>
        <Switch
          size="sm"
          aria-label={t("settings.cliEnableTitle", { name: CLI_DISPLAY_NAMES[engine] })}
          isSelected={enabled}
          onChange={onToggleEnabled}
          isDisabled={busy}
        />
      </div>
    </SettingsCard>
  );
}
