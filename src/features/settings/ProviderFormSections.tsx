import { useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import Eye from "lucide-react/dist/esm/icons/eye";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import Globe from "lucide-react/dist/esm/icons/globe";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/input/textarea";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import type { EngineId } from "./providers";
import {
  CLAUDE_MODEL_SLOTS,
  isOfficialAnthropicEndpoint,
  type ClaudeModelSlot,
  type ProviderPreset,
} from "./providerPresets";
import type { ProviderForm } from "./useProviderForm";

const FETCH_DATALIST_ID = "cli-provider-fetched-models";

const slotLabelKey = (slot: ClaudeModelSlot) =>
  `settings.cli${slot.charAt(0).toUpperCase()}${slot.slice(1)}Model`;

/** Brand mark for a preset button: explicit per-preset assets keep relay
 *  providers distinct from the model they happen to serve by default. */
function PresetIcon({ preset }: { preset: ProviderPreset }) {
  return (
    <img
      src={preset.iconSrc}
      alt=""
      className={cx("size-3.5 object-contain", preset.iconClassName)}
      aria-hidden
    />
  );
}

/** Official direct-connection card (claude/codex); selecting it pins the
 *  channel to the vendor's own endpoint. */
function OfficialPresetSection({
  engine,
  official,
  onSelect,
}: {
  engine: EngineId;
  official: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const isClaude = engine === "claude";
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-2-medium text-text-secondary">
        {t("settings.cliOfficialSection")}
      </p>
      <button
        type="button"
        aria-pressed={official}
        onClick={onSelect}
        className={cx(
          "flex w-full cursor-pointer items-center gap-3 rounded-2lg border p-3 text-left transition-colors",
          official
            ? "border-border-focus-ring bg-background-secondary-default"
            : "border-border-button-default hover:bg-background-secondary-hover",
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background-tertiary-default text-foreground-icon-primary">
          <EngineIcon engine={engine} size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body-medium text-text-primary">
            {isClaude ? t("settings.cliOfficialPreset") : t("settings.cliCodexOfficialPreset")}
          </span>
          <span className="text-body-2-regular text-text-secondary">
            {isClaude
              ? t("settings.cliOfficialPresetDesc")
              : t("settings.cliCodexOfficialPresetDesc")}
          </span>
        </span>
      </button>
    </div>
  );
}

/** Third-party relay preset grid, plus the 自定义配置 escape hatch that
 *  unlocks the URL without prefilling anything. */
function ProxyPresetSection({
  engine,
  presets,
  official,
  matchedPreset,
  onSelectCustom,
  onSelectPreset,
}: {
  engine: EngineId;
  presets: ProviderPreset[];
  official: boolean;
  matchedPreset: ProviderPreset | undefined;
  onSelectCustom: () => void;
  onSelectPreset: (preset: ProviderPreset) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-2-medium text-text-secondary">
        {t("settings.cliProxySection")}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {/* 自定义配置: pure escape hatch — unlocks the URL without
            prefilling anything. */}
        <button
          type="button"
          aria-pressed={!official && !matchedPreset}
          onClick={onSelectCustom}
          className={cx(
            "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-body-2-regular transition-colors",
            !official && !matchedPreset
              ? "border-border-focus-ring bg-background-secondary-default text-text-primary"
              : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
          )}
        >
          <Globe className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("settings.cliPresetCustom")}</span>
        </button>
        {presets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            aria-pressed={matchedPreset?.name === preset.name}
            onClick={() => onSelectPreset(preset)}
            className={cx(
              "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-body-2-regular transition-colors",
              matchedPreset?.name === preset.name
                ? "border-border-focus-ring bg-background-secondary-default text-text-primary"
                : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
            )}
          >
            <span className="shrink-0 text-foreground-icon-secondary">
              <PresetIcon preset={preset} />
            </span>
            <span className="truncate">{preset.name}</span>
          </button>
        ))}
      </div>
      {engine === "claude" && (
        <p className="text-body-2-regular text-text-tertiary">
          {t("settings.cliProxyHint")}
        </p>
      )}
    </div>
  );
}

/** 拉取模型 button plus its result/error readout; the fetched ids feed the
 *  shared datalist behind the model inputs. */
function FetchModelsControl({
  fetching,
  error,
  count,
  disabled,
  onFetch,
}: {
  fetching: boolean;
  error: string;
  count: number;
  disabled: boolean;
  onFetch: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onFetch}
        disabled={fetching || disabled}
        className="shrink-0 rounded-lg border border-border-button-default px-2 py-0.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover disabled:opacity-50"
      >
        {fetching ? t("settings.cliFetchModelsLoading") : t("settings.cliFetchModels")}
      </button>
      {error ? (
        <span className="text-body-2-regular text-text-error-primary">{error}</span>
      ) : count > 0 ? (
        <span className="text-body-2-regular text-text-tertiary">
          {t("settings.cliFetchModelsCount", { count })}
        </span>
      ) : null}
    </div>
  );
}

/** Official card (claude/codex only) plus the relay preset grid. */
export function ProviderPresetSections({
  engine,
  form,
}: {
  engine: EngineId;
  form: ProviderForm;
}) {
  const isClaude = engine === "claude";
  const isCodex = engine === "codex";
  return (
    <>
      {(isClaude || isCodex) && (
        <OfficialPresetSection
          engine={engine}
          official={form.official}
          onSelect={form.selectOfficial}
        />
      )}
      {form.presets.length > 0 && (
        <ProxyPresetSection
          engine={engine}
          presets={form.presets}
          official={form.official}
          matchedPreset={form.matchedPreset}
          onSelectCustom={form.selectCustom}
          onSelectPreset={form.selectPreset}
        />
      )}
    </>
  );
}

/** name/remark plus the flat URL/key pair (hidden for codex, which edits
 *  config.toml/auth.json instead). The claude fields mirror every keystroke
 *  into the JSON editor's env. */
export function ProviderBasicFields({
  engine,
  form,
}: {
  engine: EngineId;
  form: ProviderForm;
}) {
  const { t } = useTranslation();
  const isClaude = engine === "claude";
  const isCodex = engine === "codex";
  const [showKey, setShowKey] = useState(false);
  const { value, patch } = form;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Input
        label={t("settings.cliName")}
        isRequired
        size="small"
        placeholder={t("settings.cliNamePlaceholder")}
        value={value.name}
        onChange={(name) => patch({ name })}
        autoFocus
      />
      <Input
        label={t("settings.cliRemark")}
        size="small"
        placeholder={t("settings.cliRemarkPlaceholder")}
        value={value.remark}
        onChange={(remark) => patch({ remark })}
      />
      {!isCodex && (
        <Input
          label={t("settings.cliBaseUrl")}
          isRequired
          size="small"
          placeholder="https://…"
          value={value.baseUrl}
          onChange={(baseUrl) => {
            patch({ baseUrl });
            if (isClaude) form.updateClaudeEnv("ANTHROPIC_BASE_URL", baseUrl);
          }}
          isDisabled={form.official}
        />
      )}
      {!isCodex && (
        <div className="relative">
          <Input
            label={t("settings.cliApiKey")}
            isRequired
            size="small"
            type={showKey ? "text" : "password"}
            placeholder={isClaude ? "sk-ant-..." : "…"}
            value={value.apiKey}
            onChange={(apiKey) => {
              patch({ apiKey });
              if (isClaude) form.updateClaudeEnv("ANTHROPIC_AUTH_TOKEN", apiKey);
            }}
            fieldClassName="pr-8"
          />
          <button
            type="button"
            aria-label={t("settings.cliApiKey")}
            onClick={() => setShowKey((s) => !s)}
            className="absolute right-2 bottom-1.5 flex size-5 items-center justify-center rounded text-foreground-icon-tertiary hover:text-foreground-icon-primary"
          >
            {showKey ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/** Claude-only blocks: relay warning, 模型映射 slot inputs, and the
 *  collapsible JSON 配置 editor. */
export function ClaudeFormSections({
  engine,
  form,
}: {
  engine: EngineId;
  form: ProviderForm;
}) {
  const { t } = useTranslation();
  const [jsonOpen, setJsonOpen] = useState(true);
  if (engine !== "claude") return null;
  const { value, slots, setSlots } = form;
  return (
    <>
      {!isOfficialAnthropicEndpoint(value.baseUrl) && (
        <div className="flex items-center gap-1.5 rounded-lg border border-border-button-default bg-background-secondary-default px-3 py-2 text-body-2-regular text-text-secondary">
          <Cloud className="size-3.5 shrink-0" aria-hidden />
          <span>{t("settings.cliProxyWarning")}</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body-medium text-text-primary">
            {t("settings.cliModelMapping")}
          </p>
          <FetchModelsControl
            fetching={form.fetching}
            error={form.fetchError}
            count={form.fetchedModels.length}
            disabled={!value.baseUrl.trim()}
            onFetch={() => void form.handleFetchModels()}
          />
        </div>
        <datalist id={FETCH_DATALIST_ID}>
          {form.fetchedModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CLAUDE_MODEL_SLOTS.map(({ slot, envKey }) => (
            <Input
              key={slot}
              label={t(slotLabelKey(slot))}
              size="small"
              list={FETCH_DATALIST_ID}
              placeholder={t(`${slotLabelKey(slot)}Placeholder`)}
              value={slots[slot]}
              onChange={(model) => {
                setSlots((s) => ({ ...s, [slot]: model }));
                form.updateClaudeEnv(envKey, model);
              }}
            />
          ))}
        </div>
        <p className="text-body-2-regular text-text-tertiary">
          {t("settings.cliModelMappingHint")}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded={jsonOpen}
            onClick={() => setJsonOpen((o) => !o)}
            className="flex items-center gap-1 text-body-medium text-text-primary"
          >
            <ChevronDown
              className={cx("size-3.5 transition-transform", !jsonOpen && "-rotate-90")}
              aria-hidden
            />
            {t("settings.cliJsonConfig")}
          </button>
          <button
            type="button"
            onClick={form.handleFormatJson}
            className="rounded-lg border border-border-button-default px-2 py-0.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover"
          >
            {t("settings.cliFormatJson")}
          </button>
        </div>
        {jsonOpen && (
          <>
            <p className="text-body-2-regular text-text-tertiary">
              {t("settings.cliJsonConfigDesc")}
            </p>
            <TextArea
              mono
              rows={14}
              spellCheck={false}
              aria-label={t("settings.cliJsonConfig")}
              value={value.settingsJson}
              onChange={form.onJsonChange}
              isInvalid={!form.jsonValid}
              hint={form.jsonError || undefined}
              inputClassName="whitespace-pre"
            />
          </>
        )}
      </div>
    </>
  );
}

/** Flat engines (kimi/grok/pi/omp/dsh): 拉取模型 plus the model input fed by
 *  the shared datalist. */
export function FlatModelSection({
  engine,
  form,
}: {
  engine: EngineId;
  form: ProviderForm;
}) {
  const { t } = useTranslation();
  if (engine === "claude" || engine === "codex") return null;
  return (
    <div className="flex flex-col gap-2">
      <FetchModelsControl
        fetching={form.fetching}
        error={form.fetchError}
        count={form.fetchedModels.length}
        disabled={!form.value.baseUrl.trim()}
        onFetch={() => void form.handleFetchModels()}
      />
      <datalist id={FETCH_DATALIST_ID}>
        {form.fetchedModels.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      <Input
        label={t("settings.cliModel")}
        size="small"
        list={FETCH_DATALIST_ID}
        value={form.value.model}
        onChange={(model) => form.patch({ model })}
      />
    </div>
  );
}

/** Codex-only editors: config.toml plus auth.json with its format button. */
export function CodexFormSections({
  engine,
  form,
}: {
  engine: EngineId;
  form: ProviderForm;
}) {
  const { t } = useTranslation();
  if (engine !== "codex") return null;
  const { value, patch } = form;
  return (
    <>
      <TextArea
        mono
        rows={10}
        spellCheck={false}
        label={t("settings.cliConfigToml")}
        hint={t("settings.cliConfigTomlHint")}
        value={value.configToml}
        onChange={(configToml) => patch({ configToml })}
        inputClassName="whitespace-pre"
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body-medium text-text-primary">
            {t("settings.cliAuthJson")}
          </p>
          <button
            type="button"
            onClick={form.handleFormatAuthJson}
            className="rounded-lg border border-border-button-default px-2 py-0.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover"
          >
            {t("settings.cliFormatJson")}
          </button>
        </div>
        <TextArea
          mono
          rows={4}
          spellCheck={false}
          aria-label={t("settings.cliAuthJson")}
          value={value.authJson}
          onChange={(authJson) => {
            patch({ authJson });
            form.setAuthError("");
          }}
          isInvalid={!form.authValid}
          hint={form.authError || t("settings.cliAuthJsonHint")}
          inputClassName="whitespace-pre"
        />
      </div>
    </>
  );
}
