"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import { Switch } from "@/components/base/switch/switch";
import { inferModelEngine } from "@/components/foundations/icons/engine-brands";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import {
  CURSOR_PREFS_EVENT,
  effectiveCursorParams,
  effortParameter,
  matchCursorBase,
  orderCursorModels,
  readCursorParams,
  readCursorPins,
  writeCursorModelParams,
  type CursorModel,
  type CursorParameter,
  type CursorParamValues,
} from "./cursor-models";
import { isConcreteCursorModel } from "./cursor-model-selection";
import { useCursorModelSelection } from "./use-cursor-model-selection";

const EFFORT_IDS = new Set(["reasoning_effort", "effort", "reasoning"]);

export function useCursorModelPrefs(): { pins: string[]; params: Record<string, CursorParamValues> } {
  const [pins, setPins] = useState(readCursorPins);
  const [params, setParams] = useState(readCursorParams);
  useEffect(() => {
    const sync = () => {
      setPins(readCursorPins());
      setParams(readCursorParams());
    };
    window.addEventListener(CURSOR_PREFS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CURSOR_PREFS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return { pins, params };
}

function parameterLabel(parameter: CursorParameter, t: (key: string) => string): string {
  if (parameter.id === "fast") return "Fast";
  if (parameter.id === "context") return t("chat.cursorContext");
  if (parameter.id === "thinking") return t("chat.cursorThinking");
  if (EFFORT_IDS.has(parameter.id)) return t("chat.effort");
  return parameter.name;
}

function orderedParameters(model: CursorModel): CursorParameter[] {
  const rank = (id: string) => id === "fast" ? 0 : id === "context" ? 1 : EFFORT_IDS.has(id) ? 2 : id === "thinking" ? 3 : 4;
  return model.parameters.filter((parameter) => parameter.options.length >= 2)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** 点名称选择并启用模型；开关同步保存使用授权并将已启用项排到前面。 */
function CursorModelRow({
  model,
  selected,
  pinned,
  disabled,
  onPick,
  onPin,
}: {
  model: CursorModel;
  selected: boolean;
  pinned: boolean;
  disabled: boolean;
  onPick: () => void;
  onPin: (pinned: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={cx("flex w-full items-center gap-1 rounded-md pr-1", selected && "bg-background-primary-hover")}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onPick}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-background-primary-hover focus-visible:bg-background-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        <EngineIcon engine={inferModelEngine(model.name) ?? inferModelEngine(model.id) ?? "cursor"} size={18} className="shrink-0 text-foreground-icon-primary" />
        <span className="min-w-0 flex-1 truncate text-body-medium text-text-primary">{model.name}</span>
        {selected && <Check className="size-4 shrink-0 text-foreground-icon-primary" aria-hidden />}
      </button>
      <Switch
        size="sm"
        aria-label={t("chat.cursorEnableModel", { model: model.name })}
        isDisabled={disabled}
        isSelected={pinned}
        onChange={onPin}
      />
    </div>
  );
}

function ChoiceButtons({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; name: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap justify-end gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            "min-h-8 cursor-pointer rounded-md border px-1.5 text-body-2-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            option.value === value
              ? "border-border-button-default bg-background-primary-default text-text-primary shadow-xs"
              : "border-transparent text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
          )}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

/** 选中模型才显示它真正有的 Fast、上下文和推理档。 */
export function CursorParameterFooter({ model, saved }: { model: CursorModel; saved: CursorParamValues | undefined }) {
  const { t } = useTranslation();
  const values = effectiveCursorParams(model, saved);
  const parameters = orderedParameters(model);
  if (parameters.length === 0) return null;
  const change = (id: string, value: string) => {
    // A temporary text catalog may omit context or rename effort. Keep saved
    // options it cannot describe, and retire aliases when effort is changed.
    const next = { ...saved, ...values, [id]: value };
    if (EFFORT_IDS.has(id)) for (const alias of EFFORT_IDS) if (alias !== id) delete next[alias];
    writeCursorModelParams(model.id, next);
  };
  return (
    <div className="flex flex-col">
      <div aria-hidden className="-mx-1 mt-[7px] mb-1 h-px bg-border-button-default" />
      {parameters.map((parameter) => {
        const label = parameterLabel(parameter, t);
        const value = values[parameter.id] ?? parameter.options[0].value;
        if (parameter.id === "fast" || parameter.id === "thinking") {
          return (
            <div key={parameter.id} className="flex items-center justify-between gap-3 px-2 py-1.5">
              <span className="text-body-medium text-text-primary">{label}</span>
              <Switch size="sm" aria-label={label} isSelected={value === "true"} onChange={(on) => change(parameter.id, on ? "true" : "false")} />
            </div>
          );
        }
        return (
          <div key={parameter.id} className="flex items-start justify-between gap-2 px-2 py-1">
            <span className="pt-1.5 text-body-medium text-text-secondary">{label}</span>
            <ChoiceButtons label={label} value={value} options={parameter.options} onChange={(next) => change(parameter.id, next)} />
          </div>
        );
      })}
    </div>
  );
}

export function CursorModelList({
  models,
  selectedModelId,
  query,
  onPick,
}: {
  models: CursorModel[];
  selectedModelId: string;
  query: string;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { params } = useCursorModelPrefs();
  const selection = useCursorModelSelection(models);
  const visible = orderCursorModels(models, selection.selected, query);
  const pick = async (id: string) => {
    if (await selection.change(id, true)) onPick(id);
  };
  // 【cursor模型】旧的 high/fast 后缀仍应对到同一基础模型，不能另起一行。
  const selected = matchCursorBase(selectedModelId, models);
  return (
    <>
      <p className="px-2 py-1 text-caption-1-regular text-text-secondary">
        {t("chat.cursorSelectionNote")}
      </p>
      {(selection.loading || selection.saving) && <p role="status" className="px-2 py-1 text-caption-1-regular text-text-secondary">
        {t(selection.saving ? "chat.cursorSelectionSaving" : "common.loading")}
      </p>}
      {selection.error && <div className="px-2 py-1 text-caption-1-regular text-text-error-primary">
        <p role="alert">{selection.error}</p>
        <button type="button" className="cursor-pointer underline" onClick={() => void selection.refresh()}>{t("common.refresh")}</button>
      </div>}
      <div className="flex max-h-[280px] w-full flex-col overflow-y-auto" role="radiogroup" aria-label={t("chat.modelPicker")}>
        {visible.map((model) => (
          <CursorModelRow
            key={model.id}
            model={model}
            selected={model.id === (selected?.id ?? selectedModelId)}
            pinned={selection.selected.includes(model.id)}
            disabled={selection.loading || selection.saving || !isConcreteCursorModel(model.id)}
            onPick={() => void pick(model.id)}
            onPin={(on) => { void selection.change(model.id, on); }}
          />
        ))}
        {visible.length === 0 && <span className="p-2 text-body-medium text-text-tertiary">{t("chat.noMatchingModels")}</span>}
      </div>
      {selected && <CursorParameterFooter model={selected} saved={params[selected.id]} />}
    </>
  );
}

export function cursorTriggerLabel(models: readonly CursorModel[], selectedModelId: string, params: Record<string, CursorParamValues>): string | undefined {
  const model = matchCursorBase(selectedModelId, models);
  if (!model) return undefined;
  const saved = params[model.id];
  const effort = effortParameter(model);
  const values = effectiveCursorParams(model, saved);
  const effortName = effort?.options.find((option) => option.value === values[effort.id])?.name;
  return [model.name, effortName, values.fast === "true" ? "Fast" : ""].filter(Boolean).join(" ");
}
