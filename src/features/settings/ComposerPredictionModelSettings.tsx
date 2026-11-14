import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/application/settings/settings-rows";
import { Select, SelectItem } from "@/components/base/select/select";
import {
  isComposerPredictionEnabled,
  subscribeComposerPrediction,
} from "@/features/chat/composer-prediction";
import { ipc, type AppSettings, type EngineModel } from "@/lib/ipc";

const FOLLOW_CODEX = "follow-codex";
const modelKey = (id: string) => `model:${id}`;

export function ComposerPredictionModelSettings({ settings, onModelChange }: {
  settings: AppSettings;
  onModelChange: (model: string | null) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(isComposerPredictionEnabled);
  const [models, setModels] = useState<EngineModel[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => subscribeComposerPrediction(() => setEnabled(isComposerPredictionEnabled())), []);
  useEffect(() => {
    let alive = true;
    ipc.listEngineModels("codex").then((catalog) => {
      if (!alive) return;
      if (Array.isArray(catalog?.models)) setModels(catalog.models);
      else setFailed(true);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  const available = new Map((models ?? []).map((model) => [model.id, model]));
  for (const id of settings.customModels?.codex ?? []) {
    if (id.trim() && !available.has(id)) available.set(id, { id, provider: "" });
  }
  const selected = settings.composerPredictionModel?.trim() || null;
  const unavailable = models !== null && selected !== null && !available.has(selected);
  const label = (model: EngineModel) => settings.customModelLabels?.codex?.[model.id]?.trim()
    || model.name?.trim() || model.id;
  const choices = [
    { key: FOLLOW_CODEX, label: t("settings.composerPredictionModelDefault") },
    ...(selected && !available.has(selected) ? [{
      key: modelKey(selected),
      label: unavailable ? `${selected} · ${t("settings.composerPredictionModelUnavailable")}` : selected,
    }] : []),
    ...Array.from(available.values(), (model) => ({ key: modelKey(model.id), label: label(model) })),
  ];

  return <SettingsRow anchor="composerPredictionModel" label={t("settings.composerPredictionModel")}
    description={t(failed ? "settings.composerPredictionModelsFailed"
      : unavailable ? "settings.composerPredictionModelUnavailableDesc" : "settings.composerPredictionModelDesc")}>
    <Select aria-label={t("settings.composerPredictionModel")}
      isDisabled={!enabled || models === null || failed}
      selectedKey={selected ? modelKey(selected) : FOLLOW_CODEX}
      disabledKeys={selected && !available.has(selected) ? [modelKey(selected)] : []}
      onSelectionChange={(key) => {
        if (key === FOLLOW_CODEX) onModelChange(null);
        else {
          const chosen = Array.from(available.values()).find((model) => modelKey(model.id) === key);
          if (chosen) onModelChange(chosen.id);
        }
      }} triggerClassName="h-8 w-auto max-w-60 gap-1 rounded-lg px-2 py-1.5">
      {choices.map((choice) => <SelectItem key={choice.key} id={choice.key}>{choice.label}</SelectItem>)}
    </Select>
  </SettingsRow>;
}
