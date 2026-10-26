import { useTranslation } from "react-i18next";
import { Switch } from "@/components/base/switch/switch";
import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import { SettingsRow } from "@/components/application/settings/settings-rows";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import Play from "lucide-react/dist/esm/icons/play";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import type { CompletionAudioMode } from "./types";
import { defaultCompletionAudio } from "./config";
import type { useCompletionAudio } from "./use-completion-audio";

type Audio = ReturnType<typeof useCompletionAudio>;
const trigger = "h-8 max-w-72";
const compact = "h-8 w-36";
const MODES: CompletionAudioMode[] = ["chimeAndVoice", "chimeOnly", "voiceOnly"];
const steps = (from: number, to: number, step: number) => Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step);
/** Keep a saved value selectable even when it is off the offered grid. */
const withValue = (values: number[], value: number) => values.includes(value) ? values : [...values, value].sort((a, b) => a - b);
const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;

function EngineAudioRow({ audio, engine, disabled, chinese }: { audio: Audio; engine: string; disabled: boolean; chinese: boolean }) {
  const { t } = useTranslation();
  const feedback = useActionFeedback();
  const settings = audio.draft!.engines[engine];
  const name = CLI_DISPLAY_NAMES[engine] ?? engine;
  const auto = audio.view?.autoVoices[engine];
  const autoName = auto ? (chinese ? auto.zh : auto.en) : "";
  const known = audio.voices.some(voice => voice.name === settings.voice);
  return <SettingsRow label={name} labelAdornment={<EngineIcon engine={engine} size={16} />}>
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Select aria-label={t("assistantNotices.audioChimeFor", { engine: name })} selectedKey={String(settings.chime)} isDisabled={disabled} triggerClassName={compact}
        onSelectionChange={key => audio.changeEngine(engine, { chime: Number(key) })}>
        {steps(0, (audio.view?.chimeCount ?? 13) - 1, 1).map(index => <SelectItem key={index} id={String(index)}>{t(`assistantNotices.audioChimes.${index}`)}</SelectItem>)}
      </Select>
      <Select aria-label={t("assistantNotices.audioVoiceFor", { engine: name })} selectedKey={settings.voice || "auto"} isDisabled={disabled} triggerClassName={compact}
        onSelectionChange={key => audio.changeEngine(engine, { voice: key === "auto" ? "" : String(key) })}>
        <SelectItem id="auto">{autoName ? t("assistantNotices.audioVoiceAutoNamed", { name: autoName }) : t("assistantNotices.audioVoiceAuto")}</SelectItem>
        {settings.voice && !known ? <SelectItem id={settings.voice}>{t("assistantNotices.audioVoiceMissing", { name: settings.voice })}</SelectItem> : null}
        {audio.voices.map(voice => <SelectItem key={voice.name} id={voice.name}>{`${voice.name} · ${voice.language}`}</SelectItem>)}
      </Select>
      <Select aria-label={t("assistantNotices.audioPitchFor", { engine: name })} selectedKey={String(settings.pitch)} isDisabled={disabled} triggerClassName="h-8 w-24"
        onSelectionChange={key => audio.changeEngine(engine, { pitch: Number(key) })}>
        {withValue(steps(50, 150, 5), settings.pitch).map(value => <SelectItem key={value} id={String(value)}>{t("assistantNotices.audioPitchValue", { value })}</SelectItem>)}
      </Select>
      <Button size="small" variant="secondary" iconOnly aria-label={t("assistantNotices.audioPreviewFor", { engine: name })} title={t("assistantNotices.audioPreview")} disabled={disabled}
        onClick={() => { void feedback.start(() => audio.preview(engine)).catch(() => {}); }}>
        <ActionFeedbackIcon icon={Play} feedback={feedback.feedback} />
      </Button>
    </div>
  </SettingsRow>;
}

/** Rows rendered inside the 完成播报 card; saved by the page's Save button. */
export function CompletionAudioSettings({ audio, engines, disabled }: { audio: Audio; engines: string[]; disabled: boolean }) {
  const { t, i18n } = useTranslation();
  // Rows stay visible (and searchable) but disabled until native settings load.
  const draft = audio.draft ?? defaultCompletionAudio;
  disabled ||= !audio.draft;
  const chinese = (i18n?.language ?? "zh").startsWith("zh");
  const configurable = engines.filter(engine => draft.engines[engine]);
  return <>
    <SettingsRow anchor="completionAudioMode" label={t("assistantNotices.completionAudioMode")}>
      <Select aria-label={t("assistantNotices.completionAudioMode")} selectedKey={draft.mode} isDisabled={disabled} triggerClassName={trigger}
        onSelectionChange={key => audio.change({ mode: String(key) as CompletionAudioMode })}>
        {MODES.map(mode => <SelectItem key={mode} id={mode}>{t(`assistantNotices.audioModes.${mode}`)}</SelectItem>)}
      </Select>
    </SettingsRow>
    {(["chimeVolume", "voiceVolume"] as const).map(key => <SettingsRow key={key} anchor={key} label={t(`assistantNotices.${key}`)}>
      <Select aria-label={t(`assistantNotices.${key}`)} selectedKey={String(draft[key])} isDisabled={disabled} triggerClassName={trigger}
        onSelectionChange={value => audio.change({ [key]: Number(value) })}>
        {withValue(steps(0, 100, 10), draft[key]).map(value => <SelectItem key={value} id={String(value)}>{value === 0 ? t("assistantNotices.audioMuted") : `${value}%`}</SelectItem>)}
      </Select>
    </SettingsRow>)}
    <SettingsRow anchor="quietHours" label={t("assistantNotices.quietHours")} description={t("assistantNotices.quietHoursDescription")}>
      <div className="flex items-center gap-2">
        {draft.quietHours && <>
          <Select aria-label={t("assistantNotices.quietStart")} selectedKey={String(draft.quietStart)} isDisabled={disabled} triggerClassName="h-8 w-24"
            onSelectionChange={value => audio.change({ quietStart: Number(value) })}>
            {steps(0, 23, 1).filter(value => value !== draft.quietEnd).map(value => <SelectItem key={value} id={String(value)}>{hour(value)}</SelectItem>)}
          </Select>
          <span className="text-body-2-regular text-text-secondary" aria-hidden>–</span>
          <Select aria-label={t("assistantNotices.quietEnd")} selectedKey={String(draft.quietEnd)} isDisabled={disabled} triggerClassName="h-8 w-24"
            onSelectionChange={value => audio.change({ quietEnd: Number(value) })}>
            {steps(0, 23, 1).filter(value => value !== draft.quietStart).map(value => <SelectItem key={value} id={String(value)}>{hour(value)}</SelectItem>)}
          </Select>
        </>}
        <Switch size="sm" aria-label={t("assistantNotices.quietHours")} isSelected={draft.quietHours} isDisabled={disabled} onChange={value => audio.change({ quietHours: value })} />
      </div>
    </SettingsRow>
    {audio.draft && configurable.map(engine => <EngineAudioRow key={engine} audio={audio} engine={engine} disabled={disabled} chinese={chinese} />)}
    <SettingsRow label={t("assistantNotices.audioRules")} description={t("assistantNotices.audioRulesDescription")}>
      <Button size="small" variant="secondary" leadingIcon={RotateCcw} disabled={disabled} onClick={audio.reset}>{t("assistantNotices.audioReset")}</Button>
    </SettingsRow>
  </>;
}
