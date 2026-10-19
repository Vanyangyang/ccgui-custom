import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Save from "lucide-react/dist/esm/icons/save";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type AppSettings } from "@/lib/ipc";

/** Matches the backend default; also used as the draft for an unset URL. */
export const DEFAULT_PROXY_URL = "http://127.0.0.1:7897";

type ProxyPatch = Pick<AppSettings, "systemProxyEnabled" | "systemProxyUrl">;

/**
 * Network proxy page: master switch (persists immediately, applies to new
 * requests) plus the proxy URL (draft until 保存). The backend applies the
 * saved values to the app process env, so every engine/terminal spawned
 * afterwards inherits HTTP(S)_PROXY/ALL_PROXY; in-flight turns are untouched.
 */
export function ProxySection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [urlDraft, setUrlDraft] = useState(DEFAULT_PROXY_URL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .getAppSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setEnabledDraft(s.systemProxyEnabled ?? true);
        setUrlDraft(s.systemProxyUrl ?? DEFAULT_PROXY_URL);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Success notice auto-dismisses; errors stay until the next edit.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Read-modify-write onto a fresh read (same funnel as GeneralSection) so a
  // whole-object persist never clobbers concurrent edits from other pages.
  // Returns false on failure after rolling the drafts back to `rollback`.
  const persist = useCallback(
    async (
      patch: ProxyPatch,
      successMessage: string,
      rollback: { enabled: boolean; url: string },
    ) => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const latest = await ipc.getAppSettings();
        const next = { ...latest, ...patch };
        await ipc.updateAppSettings(next);
        setSettings(next);
        setNotice(successMessage);
        return true;
      } catch (e) {
        setEnabledDraft(rollback.enabled);
        setUrlDraft(rollback.url);
        setError(String(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const persistedEnabled = settings?.systemProxyEnabled ?? true;
  const persistedUrl = settings?.systemProxyUrl ?? DEFAULT_PROXY_URL;

  // The switch applies immediately; the URL only rides along when it is valid.
  const onToggle = (checked: boolean) => {
    if (saving || !settings) return;
    const trimmed = urlDraft.trim();
    if (checked && !trimmed) {
      setError(t("settings.proxyRequired"));
      return;
    }
    setEnabledDraft(checked);
    setError(null);
    setNotice(null);
    void persist(
      { systemProxyEnabled: checked, systemProxyUrl: trimmed || null },
      checked
        ? t("settings.proxyEnabledSuccess")
        : t("settings.proxyDisabledSuccess"),
      { enabled: persistedEnabled, url: persistedUrl },
    );
  };

  const onUrlChange = (value: string) => {
    setUrlDraft(value);
    setError(null);
  };

  const onSave = () => {
    if (saving || !settings) return;
    const trimmed = urlDraft.trim();
    if (enabledDraft && !trimmed) {
      setError(t("settings.proxyRequired"));
      return;
    }
    void persist(
      { systemProxyEnabled: enabledDraft, systemProxyUrl: trimmed || null },
      t("settings.proxySaved"),
      { enabled: persistedEnabled, url: persistedUrl },
    );
  };

  const dirty =
    persistedEnabled !== enabledDraft || persistedUrl !== urlDraft;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex w-full flex-col gap-2">
        <SettingsSectionLabel>{t("settings.proxy")}</SettingsSectionLabel>
        <p className="px-3 text-body-2-regular text-text-secondary">
          {t("settings.proxyDesc")}
        </p>
        <SettingsCard>
          <SettingsRow
            anchor="proxyEnabled"
            label={t("settings.proxyEnabled")}
            description={t("settings.proxyEnabledDesc")}
          >
            <Switch
              size="sm"
              aria-label={t("settings.proxyEnabled")}
              isSelected={enabledDraft}
              isDisabled={!settings || saving}
              onChange={onToggle}
            />
          </SettingsRow>
          <SettingsRow anchor="proxyAddress" label={t("settings.proxyAddress")}>
            <Input
              aria-label={t("settings.proxyAddress")}
              size="small"
              className="w-64"
              value={urlDraft}
              placeholder={DEFAULT_PROXY_URL}
              onChange={onUrlChange}
            />
          </SettingsRow>
        </SettingsCard>
        <div className="flex items-center gap-3 px-3 pt-2">
          <Button
            size="small"
            leadingIcon={Save}
            disabled={!settings || saving || !dirty}
            onClick={onSave}
          >
            {t("settings.proxySave")}
          </Button>
          {notice && (
            <p className="text-body-2-regular text-state-success-text">
              {notice}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="px-3 text-body-2-regular text-text-error-primary">
            {error}
          </p>
        )}
        <p className="px-3 text-body-2-regular text-text-tertiary">
          {t("settings.proxyHint")}
        </p>
      </div>
    </div>
  );
}
