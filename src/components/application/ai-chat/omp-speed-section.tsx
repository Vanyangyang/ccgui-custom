import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Zap from "lucide-react/dist/esm/icons/zap";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import { supportsOmpFastMode, type OmpServiceTier } from "@/lib/omp-service-tier";

export function OmpSpeedSection({ model, value, onChange, children, supported: supportedProp }: {
  model: string;
  children?: ReactNode;
  value: OmpServiceTier;
  onChange: (tier: OmpServiceTier) => Promise<void>;
  /** When set, bypasses the openai-codex model gate (Codex engine Fast). */
  supported?: boolean;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const supported = supportedProp ?? supportsOmpFastMode(model);
  const enabled = supported && value === "priority";
  if (!supported) return null;
  const change = async (tier: OmpServiceTier) => {
    if (saving || !supported) return;
    setSaving(true);
    setError(false);
    try { await onChange(tier); }
    catch { setError(true); }
    finally { setSaving(false); }
  };
  const buttonClass = "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-default disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2";
  return <div className="px-2 pb-1">
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        aria-label={t("chat.ompFastToggle")}
        aria-pressed={enabled}
        title={!supported ? t("chat.ompSpeedUnsupported") : value === null ? t("chat.ompSpeedInherit") : t(enabled ? "chat.ompFastDisable" : "chat.ompFastEnable")}
        disabled={!supported || saving}
        className={`${buttonClass} ${enabled ? "bg-background-tertiary-hover text-text-primary" : "bg-background-secondary-default text-text-tertiary hover:text-text-primary"}`}
        onClick={() => void change(enabled ? "default" : "priority")}
      >
        <Zap className="size-4" fill={enabled ? "currentColor" : "none"} aria-hidden />
      </button>
      <div className="min-w-0 flex-1 truncate text-center">{children}</div>
      <button
        type="button"
        aria-label={t("chat.ompSpeedReset")}
        title={t("chat.ompSpeedReset")}
        disabled={!supported || saving || value === null}
        className={`${buttonClass} text-text-tertiary hover:bg-background-secondary-default hover:text-text-primary`}
        onClick={() => void change(null)}
      >
        <RotateCcw className="size-4" aria-hidden />
      </button>
    </div>
    {error && <p role="alert" className="mt-1 text-body-2-regular text-text-primary">{t("chat.ompSpeedSaveError")}</p>}
  </div>;
}
