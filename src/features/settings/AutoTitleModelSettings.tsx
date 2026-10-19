import { useEffect, useState, type Key } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/application/settings/settings-rows";
import { Select, SelectItem } from "@/components/base/select/select";
import { EFFORT_LABEL_KEYS, getEffortLevels, normalizeEffortLevel, type EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { ipc, type AppSettings, type AutoTitleModel } from "@/lib/ipc";

const TRIGGER = "h-8 w-auto max-w-60 gap-1 rounded-lg px-2 py-1.5";
const modelKey = (engine: string, id: string) => JSON.stringify([engine, id]);

export function AutoTitleModelSettings({ settings, onModelChange, onEffortChange }: {
  settings: AppSettings;
  onModelChange: (model: AutoTitleModel) => void;
  onEffortChange: (key: Key | null) => void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<AutoTitleModel[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    ipc.autoTitleModels().then((list) => {
      if (alive) {
        if (Array.isArray(list)) {
          // Older hosts returned Claude entries without source metadata.
          setModels(list.map((model) => ({ ...model, engine: model.engine?.trim() || "claude" })));
        }
        else setFailed(true);
      }
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  // Defaults are display fallbacks only. Reading this page never enables
  // naming or writes chat model/effort preferences.
  const engine = settings.autoTitleEngine?.trim() || "claude";
  const model = settings.autoTitleModel?.trim()
    || (engine === "claude" ? "sonnet" : models?.find((item) => item.engine === engine)?.id || "default");
  const key = modelKey(engine, model);
  const selected = models?.find((item) => modelKey(item.engine, item.id) === key);
  const unavailable = models !== null && !selected;
  const levels = getEffortLevels(engine).filter((level) => !selected?.effortLevels || selected.effortLevels.includes(level));
  const normalized = engine === "pi" && settings.autoTitleEffort === "ultra"
    ? "max" : normalizeEffortLevel(engine, settings.autoTitleEffort);
  const effort = levels.includes(normalized as EffortLevel)
    ? normalized as EffortLevel : engine === "claude" ? "xhigh" : "low";
  const enabled = settings.autoTitleEnabled === true;
  // A missing entry stays visible; selecting another callable entry is the
  // only action that changes the saved source/model pair.
  const retained: AutoTitleModel = {
    engine, provider: "", id: model, name: model, resolvedModel: null, supportsEffort: false,
  };
  const choices = selected ? models ?? [] : [retained, ...(models ?? [])];
  const label = (item: AutoTitleModel) => {
    const name = item.engine === "claude" && item.id === "sonnet" && item.name.toLowerCase() === "sonnet"
      ? t("settings.autoTitleModelSonnet") : item.name;
    const missing = unavailable && modelKey(item.engine, item.id) === key;
    const source = CLI_DISPLAY_NAMES[item.engine] ?? item.engine;
    const provider = item.provider?.trim();
    const parts = [name];
    if (item.engine !== "claude" || missing) {
      parts.push(source);
      if (provider && provider.toLowerCase() !== item.engine.toLowerCase()
        && provider.toLowerCase() !== source.toLowerCase()) parts.push(provider);
    }
    if (missing) parts.push(t("settings.autoTitleModelUnavailable"));
    return parts.join(" · ");
  };

  return <>
    <SettingsRow anchor="autoTitleModel" label={t("settings.autoTitleModel")}
      description={t(failed ? "settings.autoTitleModelsFailed"
        : unavailable ? "settings.autoTitleModelUnavailableDesc" : "settings.autoTitleModelDesc")}>
      <Select aria-label={t("settings.autoTitleModel")} isDisabled={!enabled || !models?.length}
        selectedKey={key} disabledKeys={selected ? [] : [key]}
        onSelectionChange={(nextKey) => {
          const chosen = models?.find((item) => modelKey(item.engine, item.id) === nextKey);
          if (chosen) onModelChange(chosen);
        }} triggerClassName={TRIGGER}>
        {choices.map((item) => <SelectItem key={modelKey(item.engine, item.id)} id={modelKey(item.engine, item.id)}>
          {label(item)}
        </SelectItem>)}
      </Select>
    </SettingsRow>
    <SettingsRow anchor="autoTitleEffort" label={t("settings.autoTitleEffort")}
      description={t(selected && !selected.supportsEffort ? "settings.autoTitleEffortUnsupported" : "settings.autoTitleEffortDesc")}>
      <Select aria-label={t("settings.autoTitleEffort")}
        isDisabled={!enabled || !selected?.supportsEffort}
        selectedKey={effort} onSelectionChange={onEffortChange} triggerClassName={TRIGGER}>
        {levels.map((level) => <SelectItem key={level} id={level}>{t(EFFORT_LABEL_KEYS[level])}</SelectItem>)}
      </Select>
    </SettingsRow>
  </>;
}
