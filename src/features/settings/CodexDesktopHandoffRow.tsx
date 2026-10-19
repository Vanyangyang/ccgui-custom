import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsAnchorFlash } from "@/components/application/settings/settings-rows";
import { Switch } from "@/components/base/switch/switch";
import { ipc, type AppSettings } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { cx } from "@/utils/cx";

/** A host routing preference, persisted independently of Codex permissions. */
export function CodexDesktopHandoffRow() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const flashing = useSettingsAnchorFlash("codexDesktopHandoffEnabled");

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void ipc.getAppSettings().then((value) => {
      if (!cancelled) setSettings(value);
    }).catch((reason) => {
      if (!cancelled) setError(errorText(reason));
    });
    return () => { cancelled = true; mounted.current = false; };
  }, []);

  const save = async (enabled: boolean) => {
    if (!settings || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      // Merge only this preference onto a fresh read of shared settings.
      const latest = await ipc.getAppSettings();
      const next = { ...latest, codexDesktopHandoffEnabled: enabled };
      await ipc.updateAppSettings(next);
      if (mounted.current) setSettings(next);
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div
      data-setting-anchor="codexDesktopHandoffEnabled"
      className={cx("border-b border-separator-border py-2.5 pr-2.5 last:border-b-0",
        flashing && "rounded-2lg ring-2 ring-inset ring-border-focus-ring")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-body-regular text-text-primary">{t("settings.codexDesktopHandoffEnabled")}</p>
          <p className="text-body-2-regular text-text-secondary">{t("settings.codexDesktopHandoffDesc")}</p>
        </div>
        <Switch
          size="sm"
          aria-label={t("settings.codexDesktopHandoffEnabled")}
          isSelected={settings?.codexDesktopHandoffEnabled === true}
          isDisabled={!settings || saving}
          onChange={(enabled) => void save(enabled)}
        />
      </div>
      {error && <p role="alert" className="mt-2 text-body-2-regular text-text-error-primary">{error}</p>}
    </div>
  );
}
