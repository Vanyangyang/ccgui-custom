import { useTranslation } from "react-i18next";
import { Switch } from "@/components/base/switch/switch";
import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import { SettingsCard, SettingsRow, SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import { getEffortLevels, getDefaultEffort } from "@/components/application/ai-chat/effort-levels";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import Check from "lucide-react/dist/esm/icons/check";
import { isWeb } from "./api";
import { noticeModelKey, useNoticeSettings, vertexModel } from "./use-notice-settings";
import { NoticeFeedFeedback } from "./AssistantNoticesOverlay";
import { CompletionAudioSettings } from "./CompletionAudioSettings";
import { useCompletionAudio } from "./use-completion-audio";

const trigger = "h-8 max-w-72";
export function AssistantNoticesControl() {
  const { t } = useTranslation();
  const { status, draft, busy, error, models, displays, providers, catalogError, dirty, change, save, retry } = useNoticeSettings();
  const feedback = useActionFeedback();
  // Audio preferences load only after the service reports itself usable.
  const audio = useCompletionAudio(Boolean(status?.available && status.voiceAvailable));
  if (isWeb) return null;
  const disabled = !draft || busy;
  const selectedKey = draft ? noticeModelKey({ engine: draft.observerEngine, id: draft.observerModel }) : noticeModelKey(vertexModel);
  const selected = models.find(model => noticeModelKey(model) === selectedKey);
  const choices = selected || !draft ? models : [{ engine: draft.observerEngine, id: draft.observerModel, name: draft.observerModel, provider: providers[draft.observerEngine] ?? "", supportsEffort: false, resolvedModel: null }, ...models];
  const levels: string[] = selected?.engine === "agy_vertex" ? ["medium"] : getEffortLevels(draft?.observerEngine ?? "claude").filter(level => !selected?.effortLevels || selected.effortLevels.includes(level));
  const efforts = draft && !levels.includes(draft.observerEffort) ? [draft.observerEffort, ...levels] : levels;
  const target = draft?.displayTarget;
  const disconnected = target?.mode === "fixed" && !displays.some(display => display.id === target.id);
  const toggles = (keys: Array<"enabled" | "observerEnabled" | "paused" | "focusMode" | "voiceEnabled">) => keys.map(key => <SettingsRow key={key} anchor={key} label={t(`assistantNotices.${key}`)}>
    <Switch size="sm" aria-label={t(`assistantNotices.${key}`)} isSelected={draft?.[key] ?? false} isDisabled={disabled} onChange={value => change({ [key]: value })} />
  </SettingsRow>);
  return <section className="assistant-notices-settings space-y-4" aria-label={t("assistantNotices.title")} aria-busy={busy}>
    <SettingsSectionLabel>{t("assistantNotices.scopeGroup")}</SettingsSectionLabel>
    <SettingsCard>{toggles(["enabled"])}
      <SettingsRow anchor="sources" label={t("assistantNotices.sources")} description={t("assistantNotices.scopeDescription")}>
        <div className="flex max-w-80 flex-wrap gap-2">{status?.sourceEngines.map(engine => <span key={engine} className="inline-flex items-center gap-1 text-caption-1-regular"><EngineIcon engine={engine} size={16} />{CLI_DISPLAY_NAMES[engine] ?? engine}{providers[engine] ? ` · ${providers[engine]}` : ""}</span>)}</div>
      </SettingsRow>
    </SettingsCard>
    <SettingsSectionLabel>{t("assistantNotices.observerGroup")}</SettingsSectionLabel>
    <p className="text-body-2-regular text-text-secondary">{t("assistantNotices.controlsDescription")}</p>
    <SettingsCard>{toggles(["observerEnabled", "paused", "focusMode"])}
      <SettingsRow anchor="observerModel" label={t("assistantNotices.observerModel")} description={t(!selected ? "assistantNotices.modelUnavailable" : selected.engine === "agy" ? "assistantNotices.agyModelDescription" : "assistantNotices.modelDescription")}>
        <Select aria-label={t("assistantNotices.observerModel")} selectedKey={selectedKey} isDisabled={disabled} triggerClassName={trigger} onSelectionChange={key => {
          const model = models.find(item => noticeModelKey(item) === key); if (!model) return;
          const effort = model.engine === "agy_vertex" ? "medium" : !model.supportsEffort && model.effortLevels?.[0] ? model.effortLevels[0]
            : model.id === "" && draft?.observerEngine === model.engine && getEffortLevels(model.engine).some(level => level === draft.observerEffort)
            ? draft.observerEffort : model.effortLevels?.includes(getDefaultEffort(model.engine)) ? getDefaultEffort(model.engine) : model.effortLevels?.[0] ?? getDefaultEffort(model.engine);
          change({ observerEngine: model.engine, observerModel: model.id, observerEffort: effort });
        }}>{choices.map(model => <SelectItem key={noticeModelKey(model)} id={noticeModelKey(model)}>{[...new Set([model.id === "" ? t("assistantNotices.engineDefaultModel") : model.name, model.engine === "agy_vertex" ? "Vertex" : CLI_DISPLAY_NAMES[model.engine] ?? model.engine, model.provider || providers[model.engine]].filter(Boolean))].join(" · ")}</SelectItem>)}</Select>
      </SettingsRow>
      <SettingsRow anchor="observerEffort" label={t("assistantNotices.observerEffort")}>
        <Select aria-label={t("assistantNotices.observerEffort")} selectedKey={draft?.observerEffort ?? "medium"} isDisabled={disabled || !selected?.supportsEffort || selected.engine === "agy_vertex"} triggerClassName={trigger} onSelectionChange={key => change({ observerEffort: String(key) })}>
          {efforts.map(level => <SelectItem key={level} id={level}>{level}</SelectItem>)}
        </Select>
      </SettingsRow>
    </SettingsCard>
    <SettingsSectionLabel>{t("assistantNotices.voiceGroup")}</SettingsSectionLabel>
    <SettingsCard>{toggles(["voiceEnabled"])}<CompletionAudioSettings audio={audio} engines={status?.sourceEngines ?? []} disabled={disabled || audio.busy} /></SettingsCard>
    {audio.previewError && <p role="alert" className="text-body-2-regular text-text-error-primary">{t(audio.previewError)}</p>}
    {audio.voicesError && audio.draft && <p role="status" className="text-body-2-regular text-text-secondary">{t("assistantNotices.audioVoicesError")}</p>}
    <NoticeFeedFeedback error={Boolean(audio.error)} retry={audio.reload} errorKey={audio.error || "assistantNotices.audioSettingsError"} retryLabelKey="assistantNotices.audioReload" />
    <SettingsSectionLabel>{t("assistantNotices.displayGroup")}</SettingsSectionLabel>
    <SettingsCard>
      <SettingsRow anchor="displayTarget" label={t("assistantNotices.displayTarget")} description={disconnected ? t("assistantNotices.displayDisconnected") : undefined}>
        <Select aria-label={t("assistantNotices.displayTarget")} selectedKey={target?.mode === "fixed" ? `fixed:${target.id}` : "active"} isDisabled={disabled} triggerClassName={trigger} onSelectionChange={key => {
          if (key === "active") change({ displayTarget: { mode: "active" } });
          else { const display = displays.find(item => `fixed:${item.id}` === key); if (display) change({ displayTarget: { mode: "fixed", id: display.id, label: display.label } }); }
        }}>
          <SelectItem id="active">{t("assistantNotices.activeDisplay")}</SelectItem>
          {disconnected && target?.mode === "fixed" && <SelectItem id={`fixed:${target.id}`}>{target.label} · {t("assistantNotices.disconnected")}</SelectItem>}
          {displays.map(display => <SelectItem key={display.id} id={`fixed:${display.id}`}>{display.label} · {display.width} × {display.height}</SelectItem>)}
        </Select>
      </SettingsRow>
      {(["bodyTextPercent", "titleTextPercent", "interfaceTextPercent"] as const).map(key => <SettingsRow key={key} anchor={key} label={t(`assistantNotices.${key}`)}>
        <Select aria-label={t(`assistantNotices.${key}`)} selectedKey={String(draft?.[key] ?? 100)} isDisabled={disabled} triggerClassName={trigger} onSelectionChange={value => change({ [key]: Number(value) })}>
          {Array.from({ length: key === "bodyTextPercent" ? 23 : 13 }, (_, i) => 80 + i * 10).map(value => <SelectItem key={value} id={String(value)}>{value}%</SelectItem>)}
        </Select>
      </SettingsRow>)}
    </SettingsCard>
    <p className="text-body-2-regular text-text-secondary">{t("assistantNotices.sharedPreferences")} <a className="underline" href="#/settings?page=general">{t("settings.general")}</a></p>
    {status && !status.available && <p role="status">{t("assistantNotices.unavailable")}</p>}
    {status && (!status.observerAvailable || status.reason.startsWith("observer_")) && <p role="status">{t("assistantNotices.observerUnavailable")}</p>}
    {status?.reason === "legacy_preferences_unavailable" && <p role="status">{t("assistantNotices.legacyPreferencesUnavailable")}</p>}
    {status && !status.voiceAvailable && <p role="status">{t("assistantNotices.voiceUnavailable")}</p>}
    <NoticeFeedFeedback error={Boolean(error)} retry={retry} errorKey={error || "assistantNotices.settingsError"} retryLabelKey="assistantNotices.reloadSettings" />
    <NoticeFeedFeedback error={catalogError} retry={retry} errorKey="assistantNotices.catalogError" retryLabelKey="assistantNotices.reloadSettings" />
    <Button size="small" disabled={disabled || audio.busy || (!dirty && !audio.dirty && status?.reason !== "legacy_preferences_unavailable")} onClick={() => { void feedback.start(async () => {
      if (dirty || status?.reason === "legacy_preferences_unavailable") await save();
      if (audio.dirty) await audio.save();
    }).catch(() => {}); }}><ActionFeedbackIcon icon={Check} feedback={feedback.feedback} />{t("assistantNotices.save")}</Button>
  </section>;
}
