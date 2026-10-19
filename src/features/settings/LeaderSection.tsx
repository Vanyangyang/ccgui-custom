import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Collapsible } from "@/components/application/collapsible/collapsible";
import { SettingsCard, SettingsRow, SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { errorText } from "@/lib/errors";
import { ipc, type AppSettings, type EngineModel } from "@/lib/ipc";

const ENGINES = ["claude", "codex", "agy", "cursor"] as const;
type LeaderEngine = (typeof ENGINES)[number];
type PolicyMode = "unrestricted" | "restricted" | "disabled";
interface ModelPolicy { mode: PolicyMode; models: string[] }
type Draft = Record<LeaderEngine, ModelPolicy>;
const POLICY_MODES = [
  ["unrestricted", "settings.leaderModeUnrestricted"],
  ["restricted", "settings.leaderModeRestricted"],
  ["disabled", "settings.leaderModeDisabled"],
] as const;

const CONTROL_CHARACTER = /\p{Cc}/u;
function normalizedModelId(id: string): string {
  // Keep invalid saved entries visible so a failed validation never broadens
  // a restriction silently. Valid IDs share the backend's trim/dedupe rule.
  // Rust str::trim uses Unicode White_Space: unlike JS trim it includes
  // U+0085 and does not strip the otherwise valid U+FEFF model-ID character.
  const trimmed = id.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  return trimmed && !CONTROL_CHARACTER.test(trimmed) ? trimmed : id;
}

function policies(settings?: AppSettings): Draft {
  return Object.fromEntries(ENGINES.map((engine) => [engine, {
    mode: settings?.leaderAllowedModels?.[engine] == null ? "unrestricted" :
      settings.leaderAllowedModels[engine].length ? "restricted" : "disabled",
    models: [...new Set((settings?.leaderAllowedModels?.[engine] ?? []).map(normalizedModelId))],
  }])) as Draft;
}

function policyChanged(a: ModelPolicy, b: ModelPolicy): boolean {
  return a.mode !== b.mode || (a.mode === "restricted" && JSON.stringify(a.models) !== JSON.stringify(b.models));
}

function EnginePolicyCard({ engine, settings, policy, disabled, onChange }: {
  engine: LeaderEngine;
  settings?: AppSettings;
  policy: ModelPolicy;
  disabled: boolean;
  onChange: (policy: ModelPolicy) => void;
}) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<EngineModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const retry = useActionFeedback({ spin: true });
  const mounted = useRef(false);
  const request = useRef(0);
  const loadCatalog = useCallback(async () => {
    const currentRequest = ++request.current;
    const active = () => mounted.current && request.current === currentRequest;
    setLoading(true);
    try {
      const result = await ipc.listEngineModels(engine);
      if (active()) { setCatalog(result.models); setError(null); }
    } catch (reason) {
      if (active()) setError(errorText(reason));
      throw reason;
    } finally { if (active()) setLoading(false); }
  }, [engine]);
  useEffect(() => {
    mounted.current = true;
    void loadCatalog().catch(() => {});
    return () => { mounted.current = false; request.current++; };
  }, [loadCatalog]);

  const defaultModel = settings?.defaultModels?.[engine] ? normalizedModelId(settings.defaultModels[engine]) : undefined;
  const choices = [...new Set([
    ...catalog.map((model) => model.id),
    ...(settings?.customModels?.[engine] ?? []),
    ...(defaultModel ? [defaultModel] : []),
    ...(settings?.leaderAllowedModels?.[engine] ?? []),
    ...policy.models,
  ].map(normalizedModelId))];
  const fallback = defaultModel && policy.models.includes(defaultModel) ? defaultModel : policy.models[0];
  const engineLabel = CLI_DISPLAY_NAMES[engine];

  return (
    <div className="flex min-w-0 w-full flex-col gap-2">
      <SettingsSectionLabel>{engineLabel}</SettingsSectionLabel>
      <SettingsCard>
        <SettingsRow anchor={`leaderModels:${engine}`} label={t("settings.leaderRestrictModels")}
          labelAdornment={<EngineIcon engine={engine} size={14} />} />
        <div className="flex min-w-0 flex-col gap-3 py-3 pr-3">
          <div role="group" aria-label={t("settings.leaderPolicyForEngine", { engine: engineLabel })}
            className="flex min-w-0 flex-wrap gap-2">
            {POLICY_MODES.map(([mode, label]) => <Button key={mode} size="small"
              variant={policy.mode === mode ? "primary" : "secondary"}
              aria-pressed={policy.mode === mode} disabled={disabled}
              onClick={() => onChange({ mode, models: mode === "restricted" && !policy.models.length ?
                defaultModel ? [defaultModel] : catalog[0] ? [normalizedModelId(catalog[0].id)] : [] : policy.models })}>
              {t(label)}
            </Button>)}
          </div>
          <p role={policy.mode === "restricted" && policy.models.length === 0 ? "alert" : undefined}
            className={`text-body-2-regular [overflow-wrap:anywhere] ${policy.mode === "restricted" && policy.models.length === 0 ? "text-text-warning-primary" : "text-text-secondary"}`}>
            {policy.mode === "unrestricted" ? t("settings.leaderUnrestricted") :
              policy.mode === "disabled" ? t("settings.leaderDisabledPolicy") :
                policy.models.length === 0 ? t("settings.leaderEmptyPolicy") : t("settings.leaderModelFallback", { model: fallback })}
          </p>
          {loading && <p role="status" className="text-body-2-regular text-text-secondary">{t("common.loading")}</p>}
          {error && <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p role="alert" className="min-w-0 break-words text-body-2-regular text-text-error-primary">
              {t("settings.leaderCatalogError", { error })}
            </p>
            <Button variant="secondary" size="small" disabled={disabled || loading || retry.feedback === "running"} onClick={() => void retry.start(loadCatalog).catch(() => {})}
              aria-label={t("settings.leaderRetryCatalog", { engine: engineLabel })}>
              <ActionFeedbackIcon icon={RefreshCw} feedback={retry.feedback} spin iconClassName="size-[18px]" />
              {t("settings.leaderRetry")}
            </Button>
          </div>}
          <Collapsible open={policy.mode === "restricted"} seconds={0.2}>
            <div aria-hidden={policy.mode !== "restricted"} className="flex min-w-0 flex-col gap-2">
              {choices.map((id) => <Checkbox key={id} size="sm" className="min-w-0 items-start" isDisabled={disabled || policy.mode !== "restricted"}
                aria-label={`${engineLabel}: ${id}`} isSelected={policy.models.includes(id)}
                onChange={(selected) => onChange({ mode: "restricted", models: selected ? [...policy.models, id] : policy.models.filter((value) => value !== id) })}>
                <span className="[overflow-wrap:anywhere]">{!id.trim() || CONTROL_CHARACTER.test(id) ? JSON.stringify(id) : id}</span>
              </Checkbox>)}
            </div>
          </Collapsible>
        </div>
      </SettingsCard>
    </div>
  );
}

export function LeaderSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>();
  const [draft, setDraft] = useState<Draft>(() => policies());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const retry = useActionFeedback({ spin: true });
  const mounted = useRef(false);
  const request = useRef(0);
  const savePending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  const loadSettings = useCallback(async () => {
    const currentRequest = ++request.current;
    const active = () => mounted.current && request.current === currentRequest;
    setLoading(true);
    try {
      const result = await ipc.refreshAppSettings();
      if (active()) { setSettings(result); setDraft(policies(result)); setError(null); }
    } catch (reason) {
      if (active()) setError(errorText(reason));
      throw reason;
    } finally { if (active()) setLoading(false); }
  }, []);
  useEffect(() => { void loadSettings().catch(() => {}); }, [loadSettings]);

  const changed = ENGINES.filter((engine) => policyChanged(draft[engine], policies(settings)[engine]));
  const invalidDraft = ENGINES.some((engine) => draft[engine].mode === "restricted" && !draft[engine].models.length);
  const save = async () => {
    if (savePending.current || !settings || !changed.length || invalidDraft) return;
    savePending.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const latest = await ipc.refreshAppSettings();
      if (!mounted.current) return;
      const leaderAllowedModels = { ...latest.leaderAllowedModels };
      for (const engine of changed) {
        if (draft[engine].mode === "unrestricted") delete leaderAllowedModels[engine];
        else leaderAllowedModels[engine] = draft[engine].mode === "disabled" ? [] : [...draft[engine].models];
      }
      await ipc.updateAppSettings({ ...latest, leaderAllowedModels });
      const confirmed = await ipc.refreshAppSettings();
      if (!mounted.current) return;
      if (changed.some((engine) => policyChanged(draft[engine], policies(confirmed)[engine]))) {
        throw new Error(t("settings.leaderSaveMismatch"));
      }
      setSettings(confirmed);
      setDraft(policies(confirmed));
      setSaved(true);
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return <div className="flex min-w-0 w-full flex-col gap-6">
    <p className="px-3 text-body-2-regular text-text-secondary">{t("settings.leaderDesc")}</p>
    {loading && <p role="status" className="px-3 text-body-2-regular text-text-secondary">{t("common.loading")}</p>}
    {error && <div className="flex flex-wrap items-center gap-2 px-3">
      <p role="alert" className="break-words text-body-2-regular text-text-error-primary">{t("common.error")}: {error}</p>
      {!settings && <Button variant="secondary" size="small" disabled={loading || retry.feedback === "running"}
        onClick={() => void retry.start(loadSettings).catch(() => {})}>
        <ActionFeedbackIcon icon={RefreshCw} feedback={retry.feedback} spin iconClassName="size-[18px]" />
        {t("settings.leaderRetry")}
      </Button>}
    </div>}
    {ENGINES.map((engine) => <EnginePolicyCard key={engine} engine={engine} settings={settings} policy={draft[engine]}
      disabled={loading || saving || !settings} onChange={(policy) => {
        setDraft((value) => ({ ...value, [engine]: policy })); setSaved(false);
      }} />)}
    <p className="px-3 text-body-2-regular text-text-secondary">{t("settings.leaderModelsNote")}</p>
    <div className="flex flex-wrap items-center gap-3 px-3">
      <Button size="small" disabled={loading || saving || !settings || !changed.length || invalidDraft} onClick={() => void save()}>
        {saving ? t("settings.leaderSaving") : t("common.save")}
      </Button>
      {saved && <p role="status" className="text-body-2-regular text-text-secondary">{t("settings.leaderSaved")}</p>}
    </div>
  </div>;
}
