import type { KeyboardEvent } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsValueField,
} from "@/components/application/settings/settings-rows";
import { cx } from "@/utils/cx";
import type { DshHostSectionState } from "./useDshHost";

const onFieldKeyDown = (commit: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commit();
    (e.target as HTMLElement).blur();
  }
};

/**
 * Connection settings (collapsible): custom bin path, host/port, auto-start.
 * Closed/open state starts undecided (null) until the first status snapshot
 * picks the default — open when the host is down or auto-start is off.
 */
export function DshConnectionCard({ dsh }: { dsh: DshHostSectionState }) {
  const {
    t,
    connOpen,
    setConnOpen,
    host,
    port,
    autoStart,
    dshBin,
    hostDraft,
    setHostDraft,
    portDraft,
    setPortDraft,
    commitHost,
    commitPort,
    chooseBin,
    save,
  } = dsh;

  return (
    <div className="flex w-full flex-col gap-2">
      <button
        type="button"
        data-setting-anchor="dshConnection"
        aria-expanded={connOpen ?? false}
        onClick={() => setConnOpen((open) => !(open ?? true))}
        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-2lg px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-body-medium text-text-primary">
            {t("settings.dshConnectionSettings")}
          </span>
          <span className="truncate text-body-2-regular text-text-secondary">
            {t("settings.dshConnectionSummary", {
              origin: `${host}:${port}`,
              autoStart: t(autoStart ? "settings.dshAutoStartOn" : "settings.dshAutoStartOff"),
            })}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cx(
            "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
            connOpen && "rotate-180",
          )}
        />
      </button>
      {connOpen && (
        <SettingsCard>
          <SettingsRow
            anchor="dshCustomPath"
            label={t("settings.dshCustomPath")}
            description={t("settings.dshCustomPathHint")}
          >
            <div className="flex items-center gap-2">
              <SettingsValueField muted={!dshBin} className="w-40">
                {dshBin || t("settings.dshCustomPathSystem")}
              </SettingsValueField>
              <Button size="small" variant="secondary" onClick={() => void chooseBin()}>
                {t("settings.dshChoose")}
              </Button>
              {dshBin && (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => void save({ dshBin: null })}
                >
                  {t("settings.dshClear")}
                </Button>
              )}
            </div>
          </SettingsRow>
          <SettingsRow
            anchor="dshHostAddress"
            label={t("settings.dshHostAddress")}
            description={t("settings.dshHostAddressHint")}
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label={t("settings.dshHostLabel")}
                size="small"
                className="w-36"
                value={hostDraft ?? host}
                onChange={setHostDraft}
                onBlur={commitHost}
                onKeyDown={onFieldKeyDown(commitHost)}
              />
              <Input
                aria-label={t("settings.dshPortLabel")}
                size="small"
                className="w-24"
                inputClassName="text-center"
                inputMode="numeric"
                value={portDraft ?? String(port)}
                onChange={(v) => setPortDraft(v.replace(/\D/g, ""))}
                onBlur={commitPort}
                onKeyDown={onFieldKeyDown(commitPort)}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            anchor="dshAutoStart"
            label={t("settings.dshAutoStart")}
            description={t("settings.dshAutoStartHint")}
          >
            <Switch
              aria-label={t("settings.dshAutoStart")}
              size="sm"
              isSelected={autoStart}
              onChange={(isSelected) => void save({ dshAutoStart: isSelected })}
            />
          </SettingsRow>
        </SettingsCard>
      )}
    </div>
  );
}
