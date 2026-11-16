import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key } from "react";
import Ban from "lucide-react/dist/esm/icons/ban";
import Binary from "lucide-react/dist/esm/icons/binary";
import Check from "lucide-react/dist/esm/icons/check";
import Compass from "lucide-react/dist/esm/icons/compass";
import Grid3x3 from "lucide-react/dist/esm/icons/grid-3x3";
import Grip from "lucide-react/dist/esm/icons/grip";
import ImageIcon from "lucide-react/dist/esm/icons/image";
import Plus from "lucide-react/dist/esm/icons/plus";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Share2 from "lucide-react/dist/esm/icons/share-2";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import SunMedium from "lucide-react/dist/esm/icons/sun-medium";
import Upload from "lucide-react/dist/esm/icons/upload";
import Waves from "lucide-react/dist/esm/icons/waves";
import Wind from "lucide-react/dist/esm/icons/wind";

import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ConversationBackdrop } from "@/features/chat/components/ConversationBackdrop";
import type { AppSettings, ChatBackdropSettings } from "@/lib/ipc";
import { isWeb, pickFile } from "@/lib/platform";
import { cx } from "@/utils/cx";
import {
  applyBackdropPreferences,
  applyBackdropRecipe,
  backdropErrorMessage,
  CHAT_BACKDROP_RECIPES,
  DEFAULT_CHAT_BACKDROP,
  effectiveBackdropPreset,
  ensureBackdropImageLoaded,
  isProceduralBackdropPreset,
  matchesBackdropRecipe,
  normalizeBackdropHexColor,
  normalizeChatBackdrop,
  type ChatBackdropPreset,
} from "./backdrop";

const IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

const TECH_SWATCHES = ["#06b6d4", "#2563eb", "#6366f1", "#8b5cf6", "#10b981", "#f59e0b"];

const PRESET_CARDS: ReadonlyArray<{
  id: ChatBackdropPreset;
  labelKey: string;
  icon: typeof Grid3x3;
  desktopOnly?: boolean;
}> = [
  { id: "pixel-wave", labelKey: "settings.chatBackdropPresetPixelWave", icon: Grid3x3 },
  { id: "bayer-dither", labelKey: "settings.chatBackdropPresetBayerDither", icon: Binary },
  { id: "flickering-grid", labelKey: "settings.chatBackdropPresetFlickeringGrid", icon: Grip },
  { id: "silk-ribbons", labelKey: "settings.chatBackdropPresetSilkRibbons", icon: Wind },
  { id: "komorebi", labelKey: "settings.chatBackdropPresetKomorebi", icon: SunMedium },
  { id: "swiss-cross", labelKey: "settings.chatBackdropPresetSwissCross", icon: Plus },
  { id: "blueprint-grid", labelKey: "settings.chatBackdropPresetBlueprintGrid", icon: Compass },
  { id: "dot-constellation", labelKey: "settings.chatBackdropPresetDotConstellation", icon: Share2 },
  { id: "aurora-mesh", labelKey: "settings.chatBackdropPresetAuroraMesh", icon: Sparkles },
  { id: "topographic", labelKey: "settings.chatBackdropPresetTopographic", icon: Waves },
  {
    id: "custom-image",
    labelKey: "settings.chatBackdropPresetCustomImage",
    icon: ImageIcon,
    desktopOnly: true,
  },
  { id: "none", labelKey: "settings.chatBackdropPresetNone", icon: Ban },
];

const SELECT_TRIGGER = "h-8 w-auto gap-1 rounded-lg px-2 py-1.5";
const SAVE_DEBOUNCE_MS = 200;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  valueLabel,
  onChange,
}: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <SettingsRow label={label} description={description}>
      <div className="flex shrink-0 items-center gap-2.5">
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-1.5 w-32 cursor-pointer accent-accent-500 sm:w-36"
        />
        <span className="w-11 text-right text-caption-1-medium tabular-nums text-text-secondary">
          {valueLabel}
        </span>
      </div>
    </SettingsRow>
  );
}

/** Conversation backdrop preset selector, live contrast preview, and DIY controls. */
export function ChatBackdropSection({
  settings,
  onSaveBackdrop,
  onError,
}: {
  settings: AppSettings;
  onSaveBackdrop: (backdrop: ChatBackdropSettings) => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ChatBackdropSettings>(() =>
    normalizeChatBackdrop(settings.chatBackdrop),
  );
  const [imageBusy, setImageBusy] = useState(false);

  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ChatBackdropSettings | null>(null);
  const onSaveRef = useRef(onSaveBackdrop);
  onSaveRef.current = onSaveBackdrop;

  useEffect(() => {
    if (pendingRef.current) return;
    const incoming = normalizeChatBackdrop(settings.chatBackdrop);
    setDraft(incoming);
    applyBackdropPreferences(incoming);
  }, [settings.chatBackdrop]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingRef.current) {
        const latest = pendingRef.current;
        pendingRef.current = null;
        onSaveRef.current(latest);
      }
    };
  }, []);

  const commitBackdrop = useCallback((next: ChatBackdropSettings, immediate = false) => {
    const normalized = normalizeChatBackdrop(next);
    setDraft(normalized);
    applyBackdropPreferences(normalized);

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (immediate) {
      pendingRef.current = null;
      onSaveRef.current(normalized);
      return;
    }

    pendingRef.current = normalized;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const toSave = pendingRef.current;
      pendingRef.current = null;
      if (toSave) onSaveRef.current(toSave);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const handlePickImage = async () => {
    const picked = await pickFile(t("settings.chatBackdropPickTitle"), [
      { name: t("settings.chatBackdropImageFilter"), extensions: IMAGE_FILE_EXTENSIONS },
    ]);
    if (!picked) return;
    setImageBusy(true);
    try {
      await ensureBackdropImageLoaded(picked, { force: true });
      onError(null);
      commitBackdrop({ ...draft, preset: "custom-image", imageFile: picked }, true);
    } catch (err) {
      onError(backdropErrorMessage(err, t));
    } finally {
      setImageBusy(false);
    }
  };

  const activePreset = effectiveBackdropPreset(draft);
  const isProcedural = isProceduralBackdropPreset(activePreset);
  const presets = PRESET_CARDS.filter((item) => !(isWeb && item.desktopOnly));
  const isDefault =
    JSON.stringify(draft) === JSON.stringify(DEFAULT_CHAT_BACKDROP);

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel anchor="chatBackdrop">
        {t("settings.chatBackdrop")}
      </SettingsSectionLabel>
      <SettingsCard>
        <div className="flex flex-col gap-3.5 border-b border-separator-border py-3 pr-2.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-body-2-regular text-text-secondary">
              {t("settings.chatBackdropDesc")}
            </p>
            <Button
              size="small"
              variant="ghost"
              leadingIcon={RotateCcw}
              disabled={isDefault}
              onClick={() => commitBackdrop(DEFAULT_CHAT_BACKDROP, true)}
            >
              {t("settings.chatBackdropReset")}
            </Button>
          </div>

          {/* Live contrast & composition preview */}
          <div
            data-testid="chat-backdrop-preview"
            className="relative isolate flex h-28 w-full flex-col justify-between overflow-hidden rounded-xl border border-separator-border bg-background-primary-default p-3"
          >
            <ConversationBackdrop preview />
            <div className="relative z-10 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-separator-border/80 bg-background-primary-default/80 px-2 py-0.5 text-[11px] font-medium text-text-secondary backdrop-blur-xs">
                <ShieldCheck className="size-3 text-accent-500" aria-hidden />
                {t("settings.chatBackdropContrastBadge", { scrim: draft.scrim })}
              </span>
              <span className="max-w-[52%] truncate rounded-xl bg-bubble-user px-2.5 py-1 text-[11px] font-medium text-bubble-user-foreground shadow-xs">
                {t("settings.chatBackdropPreviewUser")}
              </span>
            </div>
            <div className="relative z-10 mx-auto w-full max-w-[380px] text-left">
              <p className="truncate text-body-2-medium text-text-primary">
                {t("settings.chatBackdropPreviewTitle")}
              </p>
              <p className="truncate text-caption-1-regular text-text-secondary">
                {t("settings.chatBackdropPreviewBody")}
              </p>
            </div>
          </div>

          {/* Mood recipes */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-caption-1-medium text-text-secondary">
                {t("settings.chatBackdropRecipes")}
              </span>
              <span className="text-[11px] text-text-tertiary">
                {t("settings.chatBackdropRecipesHint")}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {CHAT_BACKDROP_RECIPES.map((recipe) => {
                const active = matchesBackdropRecipe(draft, recipe);
                return (
                  <button
                    key={recipe.id}
                    type="button"
                    data-backdrop-recipe={recipe.id}
                    aria-pressed={active}
                    onClick={() => commitBackdrop(applyBackdropRecipe(draft, recipe), true)}
                    className={cx(
                      "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-caption-1-medium transition-all duration-150",
                      active
                        ? "border-accent-500 bg-pill-tab-blue-selected-background text-text-primary ring-1 ring-accent-500/30"
                        : "border-border-button-default bg-background-primary-default text-text-secondary hover:border-border-button-hover hover:bg-background-primary-hover hover:text-text-primary",
                    )}
                  >
                    <span className="inline-flex shrink-0 items-center -space-x-1" aria-hidden>
                      <span
                        className="size-2.5 rounded-full ring-1 ring-background-primary-default"
                        style={{ backgroundColor: recipe.swatchPrimary }}
                      />
                      <span
                        className="size-2.5 rounded-full ring-1 ring-background-primary-default"
                        style={{ backgroundColor: recipe.swatchSecondary }}
                      />
                    </span>
                    <span className="whitespace-nowrap">{t(recipe.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Preset pills */}
          <div className="flex flex-col gap-1.5">
            <span className="text-caption-1-medium text-text-secondary">
              {t("settings.chatBackdropPresetsLabel")}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {presets.map((item) => {
                const Icon = item.icon;
                const selected = activePreset === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => commitBackdrop({ ...draft, preset: item.id }, true)}
                    className={cx(
                      "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-caption-1-medium transition-all duration-150",
                      selected
                        ? "border-accent-500 bg-pill-tab-blue-selected-background text-text-primary ring-1 ring-accent-500/30"
                        : "border-border-button-default bg-background-primary-default text-text-secondary hover:border-border-button-hover hover:bg-background-primary-hover hover:text-text-primary",
                    )}
                  >
                    <Icon
                      className={cx(
                        "size-3.5 shrink-0",
                        selected ? "text-accent-500" : "text-foreground-icon-secondary",
                      )}
                      aria-hidden
                    />
                    <span className="whitespace-nowrap">{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {activePreset !== "none" && (
          <>
            <SliderRow
              label={t("settings.chatBackdropOpacity")}
              value={draft.opacity}
              min={10}
              max={100}
              valueLabel={`${draft.opacity}%`}
              onChange={(opacity) => commitBackdrop({ ...draft, opacity })}
            />
            <SliderRow
              label={t("settings.chatBackdropScrim")}
              description={t("settings.chatBackdropScrimDesc")}
              value={draft.scrim}
              min={0}
              max={100}
              valueLabel={`${draft.scrim}%`}
              onChange={(scrim) => commitBackdrop({ ...draft, scrim })}
            />
            <SettingsRow
              label={t("settings.chatBackdropParallax")}
              description={t("settings.chatBackdropParallaxDesc")}
            >
              <Switch
                size="sm"
                aria-label={t("settings.chatBackdropParallax")}
                isSelected={draft.parallax}
                onChange={(parallax) => commitBackdrop({ ...draft, parallax }, true)}
              />
            </SettingsRow>
          </>
        )}

        {isProcedural && (
          <>
            <SliderRow
              label={t("settings.chatBackdropSpeed")}
              value={draft.speed}
              min={0}
              max={150}
              step={5}
              valueLabel={
                draft.speed === 0 ? t("settings.chatBackdropStatic") : `${draft.speed}%`
              }
              onChange={(speed) => commitBackdrop({ ...draft, speed })}
            />
            <SliderRow
              label={t("settings.chatBackdropScale")}
              value={draft.scale}
              min={20}
              max={100}
              valueLabel={`${draft.scale}%`}
              onChange={(scale) => commitBackdrop({ ...draft, scale })}
            />
            <SettingsRow
              label={t("settings.chatBackdropColorMode")}
              description={
                draft.colorMode === "custom"
                  ? t("settings.chatBackdropColorGuardHint")
                  : undefined
              }
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="flex items-center gap-1 rounded-lg border border-border-button-default bg-background-secondary-default p-0.5">
                  <button
                    type="button"
                    aria-pressed={draft.colorMode !== "custom"}
                    onClick={() =>
                      commitBackdrop({ ...draft, colorMode: "accent" }, true)
                    }
                    className={cx(
                      "cursor-pointer rounded-md px-2 py-1 text-caption-1-medium transition-colors",
                      draft.colorMode !== "custom"
                        ? "bg-background-primary-default text-text-primary shadow-2xs"
                        : "text-text-secondary hover:text-text-primary",
                    )}
                  >
                    {t("settings.chatBackdropColorAccent")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={draft.colorMode === "custom"}
                    onClick={() =>
                      commitBackdrop({ ...draft, colorMode: "custom" }, true)
                    }
                    className={cx(
                      "cursor-pointer rounded-md px-2 py-1 text-caption-1-medium transition-colors",
                      draft.colorMode === "custom"
                        ? "bg-background-primary-default text-text-primary shadow-2xs"
                        : "text-text-secondary hover:text-text-primary",
                    )}
                  >
                    {t("settings.chatBackdropColorCustom")}
                  </button>
                </div>

                {draft.colorMode === "custom" && (
                  <div className="flex items-center gap-1.5">
                    {TECH_SWATCHES.map((swatch) => {
                      const activeSwatch =
                        normalizeBackdropHexColor(draft.customColor) === swatch;
                      return (
                        <button
                          key={swatch}
                          type="button"
                          aria-label={swatch}
                          aria-pressed={activeSwatch}
                          onClick={() =>
                            commitBackdrop({ ...draft, customColor: swatch }, true)
                          }
                          style={{ backgroundColor: swatch }}
                          className={cx(
                            "flex size-5 cursor-pointer items-center justify-center rounded-full border border-black/15 text-white transition-transform hover:scale-110",
                            activeSwatch &&
                              "ring-2 ring-text-primary ring-offset-1 ring-offset-background-primary-default",
                          )}
                        >
                          {activeSwatch && <Check className="size-3 stroke-[2.5]" aria-hidden />}
                        </button>
                      );
                    })}
                    <input
                      type="color"
                      aria-label={t("settings.chatBackdropColorPickAria")}
                      value={normalizeBackdropHexColor(draft.customColor)}
                      onChange={(e) =>
                        commitBackdrop({ ...draft, customColor: e.target.value })
                      }
                      className="h-6 w-7 cursor-pointer rounded border border-border-button-default bg-transparent p-0"
                    />
                  </div>
                )}
              </div>
            </SettingsRow>
          </>
        )}

        {activePreset === "custom-image" && !isWeb && (
          <>
            <SettingsRow
              label={t("settings.chatBackdropImageFile")}
              description={t("settings.chatBackdropImageFileDesc")}
            >
              <Button
                size="small"
                variant="secondary"
                leadingIcon={Upload}
                disabled={imageBusy}
                onClick={() => void handlePickImage()}
              >
                <span className="block max-w-56 truncate" title={draft.imageFile || undefined}>
                  {draft.imageFile
                    ? fileNameOf(draft.imageFile)
                    : t("settings.chatBackdropChooseImage")}
                </span>
              </Button>
            </SettingsRow>
            <SliderRow
              label={t("settings.chatBackdropBlur")}
              value={draft.blur}
              min={0}
              max={24}
              valueLabel={`${draft.blur}px`}
              onChange={(blur) => commitBackdrop({ ...draft, blur })}
            />
            <SettingsRow label={t("settings.chatBackdropFit")}>
              <Select
                aria-label={t("settings.chatBackdropFit")}
                selectedKey={draft.fit}
                onSelectionChange={(key: Key | null) => {
                  if (key != null) {
                    commitBackdrop({ ...draft, fit: String(key) }, true);
                  }
                }}
                triggerClassName={SELECT_TRIGGER}
              >
                <SelectItem id="cover">{t("settings.chatBackdropFitCover")}</SelectItem>
                <SelectItem id="contain">{t("settings.chatBackdropFitContain")}</SelectItem>
                <SelectItem id="repeat">{t("settings.chatBackdropFitRepeat")}</SelectItem>
              </Select>
            </SettingsRow>
          </>
        )}
      </SettingsCard>
    </div>
  );
}
