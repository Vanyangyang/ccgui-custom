import { useTranslation } from "react-i18next";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { ModalShell } from "@/components/dialogs";
import type { EngineId } from "./providers";
import {
  ClaudeFormSections,
  CodexFormSections,
  FlatModelSection,
  ProviderBasicFields,
  ProviderPresetSections,
} from "./ProviderFormSections";
import { useProviderForm } from "./useProviderForm";

/**
 * Add/edit one provider channel, per engine:
 *   - claude: preset cards → name/remark/URL/key → 模型映射 (per-tier default
 *     models) → JSON 配置 editor. Fields and the JSON editor stay in sync
 *     both ways; the JSON is saved as the channel's settingsConfig.
 *   - codex: preset cards → name/remark → config.toml + auth.json editors
 *     (saved as settingsConfig.config / settingsConfig.auth; flat baseUrl/
 *     apiKey/model mirrors are extracted from them at submit for the row
 *     display and model picker).
 *   - kimi/grok/pi/omp/dsh: preset cards → flat name/remark/URL/key/model,
 *     with a 拉取模型 datalist on the model field.
 *
 * `raw` stays with the parent and is merged back on save so fields this form
 * doesn't know (source, customModels, …) survive.
 */
export interface ProviderFormValue {
  name: string;
  remark: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** claude: full settings.json text → stored as settingsConfig. */
  settingsJson: string;
  /** codex: config.toml text → stored as settingsConfig.config. */
  configToml: string;
  /** codex: auth.json text → stored as settingsConfig.auth. */
  authJson: string;
}

interface ProviderDialogProps {
  engine: EngineId;
  title: string;
  initial?: ProviderFormValue;
  onSubmit: (value: ProviderFormValue) => void;
  onCancel: () => void;
}

/** Dialog shell: header + form wiring. State/mutations live in
 *  useProviderForm; per-engine field groups live in ProviderFormSections. */
export function ProviderDialog({ engine, title, initial, onSubmit, onCancel }: ProviderDialogProps) {
  const { t } = useTranslation();
  const form = useProviderForm({ engine, initial, onSubmit });

  return (
    <ModalShell
      onClose={onCancel}
      className="max-h-[calc(100vh-48px)] w-[560px] max-w-[calc(100vw-32px)] overflow-y-auto p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-title-3-medium text-text-primary">{title}</p>
        <button
          type="button"
          aria-label={t("common.cancel")}
          onClick={onCancel}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="mt-1.5 text-body-2-regular text-text-secondary">
        {t("settings.cliDialogNote")}
      </p>
      <form
        className="mt-5 flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          form.submit();
        }}
      >
        <ProviderPresetSections engine={engine} form={form} />
        <ProviderBasicFields engine={engine} form={form} />
        <ClaudeFormSections engine={engine} form={form} />
        <FlatModelSection engine={engine} form={form} />
        <CodexFormSections engine={engine} form={form} />

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="small" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="small" disabled={!form.valid}>
            {t("common.confirm")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
