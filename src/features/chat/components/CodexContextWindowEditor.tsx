import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/base/input/input";
import { Button } from "@/components/base/buttons/button";
import type { CodexContextWindowSettings } from "@/lib/ipc";

export function CodexContextWindowEditor({ settings, reportedWindow, onSave }: {
  settings: CodexContextWindowSettings;
  reportedWindow?: number;
  onSave: (contextWindow: number | null, autoCompactTokenLimit: number | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [windowText, setWindowText] = useState("");
  const [compactText, setCompactText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty) {
      setWindowText(settings.contextWindow == null ? "" : String(settings.contextWindow / 1000));
      setCompactText(settings.autoCompactTokenLimit == null ? "" : String(settings.autoCompactTokenLimit / 1000));
    }
  }, [settings.contextWindow, settings.autoCompactTokenLimit, dirty]);
  async function save(reset: boolean) {
    if (settings.block || inFlight.current) return;
    const window = reset || !windowText.trim() ? null : Number(windowText) * 1000;
    const compact = reset || !compactText.trim() ? null : Number(compactText) * 1000;
    const error = [window, compact].some(value => value !== null && (!Number.isInteger(value) || value < 100_000 || value > 1_000_000))
      ? "chat.codexContextRangeError" : window !== null && compact !== null && compact > window ? "chat.codexContextThresholdError" : null;
    if (error) { setFailed(true); setMessage(t(error)); return; }
    inFlight.current = true; setSaving(true); setMessage("");
    try {
      await onSave(window, compact);
      if (mounted.current) {
        setDirty(false); setFailed(false);
        setMessage(t(reset ? "chat.codexContextResetDone" : "chat.codexContextSaveDone"));
      }
    } catch {
      if (mounted.current) { setFailed(true); setMessage(t("chat.codexContextSaveFailed")); }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const disabled = Boolean(settings.block) || saving;
  return <div className="flex flex-col gap-2 px-4 pb-3">
    <Input size="small" label={t("chat.codexContextWindowSize")} value={windowText} inputMode="decimal"
      placeholder={reportedWindow !== undefined && reportedWindow > 0 ? String(reportedWindow / 1000) : t("chat.codexContextDefault")}
      isDisabled={disabled} onChange={value => { setWindowText(value); setDirty(true); setMessage(""); }} />
    <Input size="small" label={t("chat.codexContextCompactSize")} value={compactText} inputMode="decimal"
      placeholder={t("chat.codexContextDefault")} isDisabled={disabled}
      onChange={value => { setCompactText(value); setDirty(true); setMessage(""); }} />
    <div className="flex gap-2">
      <Button size="small" disabled={disabled} onClick={() => { void save(false); }}>{t(saving ? "chat.contextWindowSaving" : "chat.contextWindowSave")}</Button>
      <Button size="small" variant="secondary" disabled={disabled} onClick={() => { void save(true); }}>{t("chat.contextWindowReset")}</Button>
    </div>
    <p className="text-caption-1-regular text-text-tertiary">{t("chat.codexContextScope")}</p>
    {settings.block && <p className="text-caption-1-regular text-text-tertiary">{t(`chat.codexContextBlock_${settings.block}`)}</p>}
    {message && <p role={failed ? "alert" : "status"} className="text-caption-1-regular text-text-secondary">{message}</p>}
  </div>;
}
