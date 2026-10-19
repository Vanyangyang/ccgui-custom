import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key, KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Upload from "lucide-react/dist/esm/icons/upload";

import { Select, SelectItem } from "@/components/base/select/select";
import { Input } from "@/components/base/input/input";
import { Button } from "@/components/base/buttons/button";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type AppSettings, type AutoTitleModel } from "@/lib/ipc";
import { IS_WINDOWS, isWeb, pickFile } from "@/lib/platform";
import { applyTheme } from "./theme";
import {
  applyFontPreferences,
  CUSTOM_FONT_VALUE,
  ensureCustomFontLoaded,
  fontErrorMessage,
  fontRole,
  normalizeFontMode,
  type FontField,
  type FontPreferences,
} from "./font";
import { changeZoom, onZoomChange, readZoomPct, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "@/lib/zoom";
import { PromptHistoryManager, PromptHistoryToggleRow } from "./PromptHistorySettings";
import { useChatStore } from "@/features/chat/store";
import { AutoTitleModelSettings } from "./AutoTitleModelSettings";

export const LANGUAGE_STORAGE_KEY = "ccgui-next.language";

/** Compact select trigger (h 32, radius/lg) per the Figma settings rows. */
const SELECT_TRIGGER = "h-8 w-auto gap-1 rounded-lg px-2 py-1.5";
/** Sidebar thread limit bounds (integers only). */
const THREAD_LIMIT_MIN = 1;
const THREAD_LIMIT_MAX = 30;
const THREAD_LIMIT_DEFAULT = 5;
/** Interface zoom presets: every step between the bounds so a percent set
 *  from the status bar or a shortcut always matches a select item. */
const ZOOM_PRESETS: number[] = [];
for (let v = ZOOM_MIN; v <= ZOOM_MAX; v += ZOOM_STEP) ZOOM_PRESETS.push(v);

/** Extensions offered by the font file dialog; the backend additionally
 *  checks the first bytes, so a renamed file still fails with a clear error. */
const FONT_FILE_EXTENSIONS = ["ttf", "otf", "ttc", "woff", "woff2"];

/** AppSettings → the four font fields applyFontPreferences persists. */
function fontPreferencesOf(settings: AppSettings): FontPreferences {
  return {
    fontFamily: settings.fontFamily,
    codeFontFamily: settings.codeFontFamily,
    fontFile: settings.fontFile,
    codeFontFile: settings.codeFontFile,
  };
}

/** App-settings state + persistence for the General page. Kept JSX-free so
 *  the component below only composes the cards. */
function useGeneralSettingsState() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Raw digits while editing the thread limit; null = show the saved value.
  const [limitText, setLimitText] = useState<string | null>(null);
  // 正在读取/注册上传字体的行；null = 空闲，用于禁用再次点选。
  const [fontBusy, setFontBusy] = useState<FontField | null>(null);
  // 窗口当前是否有系统装饰（isDecorated）；null = 还没读回来。
  const [decorated, setDecorated] = useState<boolean | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const restartInFlight = useRef(false);
  const namingSaveQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    ipc
      .getAppSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        applyTheme(s.theme);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // "system" theme follows the OS via a listener bound at the app root
  // (App.tsx → bindSystemThemeSync), so it works without opening Settings.

  // Read-modify-write: the local `settings` descends from a mount-time
  // snapshot; persisting it whole would clobber concurrent edits (CLI config
  // page, chat-side model pinning). Apply each patch onto a fresh read.
  const save = useCallback(async (patch: Partial<AppSettings>): Promise<boolean> => {
    try {
      const latest = await ipc.getAppSettings();
      const next = { ...latest, ...patch };
      await ipc.updateAppSettings(next);
      setSettings(next);
      setError(null);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  const onThemeChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const theme = String(key);
    setSettings({ ...settings, theme });
    applyTheme(theme);
    void save({ theme });
  };

  // 「窗口现在有没有系统装饰」= 当前实际生效的标题栏样式，用来判断设置是否
  // 需要重启才生效（restart 按钮的可用态）。仅 Windows 需要。
  useEffect(() => {
    if (!IS_WINDOWS || isWeb) return;
    let alive = true;
    getCurrentWindow()
      .isDecorated()
      .then((value) => {
        if (alive) setDecorated(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onTitlebarChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const titlebar = String(key);
    setSettings({ ...settings, titlebar });
    void save({ titlebar });
  };

  const onRestart = async () => {
    // State disables the rendered button; the ref also covers clicks before
    // React commits that disabled state.
    if (restartInFlight.current) return;
    restartInFlight.current = true;
    setRestartPending(true);
    setError(null);
    try {
      await ipc.restartApp();
    } catch (e) {
      setError(
        t("settings.restartFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      restartInFlight.current = false;
      setRestartPending(false);
    }
  };

  const onLanguageChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const language = String(key);
    setSettings({ ...settings, language });
    void i18n.changeLanguage(language);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    void save({ language });
  };
  const commitThreadLimit = (n: number) => {
    if (!settings || n === settings.sidebarThreadLimit) return;
    setSettings({ ...settings, sidebarThreadLimit: n });
    useChatStore.getState().setThreadLimit(n);
    void save({ sidebarThreadLimit: n });
  };
  // Typing only edits the raw text; committing per keystroke would fire a
  // settings write per digit. Commit on blur or Enter instead.
  const onThreadLimitChange = (v: string) => {
    if (!settings) return;
    setLimitText(v.replace(/\D/g, ""));
  };
  const commitThreadLimitText = () => {
    if (settings && limitText) {
      const n = Number(limitText);
      commitThreadLimit(Math.min(THREAD_LIMIT_MAX, Math.max(THREAD_LIMIT_MIN, n)));
    }
    setLimitText(null);
  };
  const onThreadLimitKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitThreadLimitText();
      (e.target as HTMLElement).blur();
    }
  };

  const onSendShortcutChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const composerSendShortcut = String(key);
    setSettings({ ...settings, composerSendShortcut });
    useChatStore.getState().setSendShortcut(composerSendShortcut);
    void save({ composerSendShortcut });
  };
  const onThinkingAutoCollapseChange = (autoCollapse: boolean) => {
    if (!settings) return;
    setSettings({ ...settings, thinkingAutoCollapse: autoCollapse });
    useChatStore.getState().setThinkingAutoCollapse(autoCollapse);
    void save({ thinkingAutoCollapse: autoCollapse });
  };
  // Only the host reads these (after each turn), so no store mirror.
  const saveNaming = (patch: Partial<AppSettings>) => {
    // Serialize rapid naming picks: each merge reads the preceding saved value.
    namingSaveQueue.current = namingSaveQueue.current.then(() => save(patch));
  };
  const onAutoTitleEnabledChange = (autoTitleEnabled: boolean) => {
    if (!settings) return;
    saveNaming({ autoTitleEnabled });
  };
  const onAutoTitleModelChange = (model: AutoTitleModel) => {
    if (!settings) return;
    saveNaming({ autoTitleEngine: model.engine, autoTitleModel: model.id });
  };
  const onAutoTitleEffortChange = (key: Key | null) => {
    if (!settings || key == null) return;
    const autoTitleEffort = String(key);
    saveNaming({ autoTitleEffort });
  };
  /** Font mode commits (默认 / 系统 / 自定义): apply to the document root at
   *  once (bootstrap re-reads the mirror on the next launch) and persist.
   *  Entering 自定义 with an uploaded file re-applies that file right away;
   *  without one the row keeps the mode open until a file is picked. */
  const onFontModeChange = (field: FontField, value: string) => {
    if (!settings) return;
    const next = { ...settings, [field]: value };
    setSettings(next);
    applyFontPreferences(fontPreferencesOf(next));
    void save({ [field]: value });
    const path = value === "custom" ? next[field === "fontFamily" ? "fontFile" : "codeFontFile"] : "";
    if (path) {
      void ensureCustomFontLoaded(fontRole(field), path).catch((e) =>
        setError(fontErrorMessage(e, t)),
      );
    }
  };

  /** 上传字体：读取并注册成功后才落设置（失败保留原选择并报错）。 */
  const onFontFilePick = async (field: FontField): Promise<boolean> => {
    if (!settings) return false;
    const path = await pickFile(t("settings.fontPickTitle"), [
      { name: t("settings.fontFileFilter"), extensions: FONT_FILE_EXTENSIONS },
    ]);
    if (!path) return false;
    setFontBusy(field);
    try {
      await ensureCustomFontLoaded(fontRole(field), path, { force: true });
      const fileField = field === "fontFamily" ? "fontFile" : "codeFontFile";
      const next = { ...settings, [field]: "custom", [fileField]: path };
      setSettings(next);
      applyFontPreferences(fontPreferencesOf(next));
      void save({ [field]: "custom", [fileField]: path });
      setError(null);
      return true;
    } catch (e) {
      setError(fontErrorMessage(e, t));
      return false;
    } finally {
      setFontBusy(null);
    }
  };
  return {
    settings,
    error,
    limitText,
    decorated,
    restartPending,
    fontBusy,
    onThemeChange,
    onTitlebarChange,
    onRestart,
    onLanguageChange,
    onThreadLimitChange,
    commitThreadLimitText,
    onThreadLimitKeyDown,
    onSendShortcutChange,
    onThinkingAutoCollapseChange,
    onAutoTitleEnabledChange,
    onAutoTitleModelChange,
    onAutoTitleEffortChange,
    onFontModeChange,
    onFontFilePick,
  };
}

/** Appearance card: theme, Windows titlebar + restart, language, thread limit. */
function AppearanceCard({
  settings,
  limitText,
  decorated,
  restartPending,
  fontBusy,
  onThemeChange,
  onTitlebarChange,
  onRestart,
  onLanguageChange,
  onFontModeChange,
  onFontFilePick,
  onThreadLimitChange,
  onThreadLimitCommit,
  onThreadLimitKeyDown,
}: {
  settings: AppSettings;
  limitText: string | null;
  decorated: boolean | null;
  restartPending: boolean;
  fontBusy: FontField | null;
  onThemeChange: (key: Key | null) => void;
  onTitlebarChange: (key: Key | null) => void;
  onRestart: () => Promise<void>;
  onLanguageChange: (key: Key | null) => void;
  onFontModeChange: (field: FontField, value: string) => void;
  onFontFilePick: (field: FontField) => Promise<boolean>;
  onThreadLimitChange: (value: string) => void;
  onThreadLimitCommit: () => void;
  onThreadLimitKeyDown: (event: KeyboardEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("settings.appearance")}</SettingsSectionLabel>
      <SettingsCard>
        <SettingsRow anchor="theme" label={t("settings.theme")}>
          <Select
            aria-label={t("settings.theme")}
            selectedKey={settings.theme}
            onSelectionChange={onThemeChange}
            triggerClassName={SELECT_TRIGGER}
          >
            <SelectItem id="system">{t("settings.themeSystem")}</SelectItem>
            <SelectItem id="light">{t("settings.themeLight")}</SelectItem>
            <SelectItem id="dark">{t("settings.themeDark")}</SelectItem>
          </Select>
        </SettingsRow>
      {IS_WINDOWS && !isWeb && (
          <SettingsRow
            anchor="titlebar"
            label={t("settings.titlebar")}
            description={t("settings.titlebarRestartHint")}
          >
            <div className="flex items-center gap-2">
              <Select
                aria-label={t("settings.titlebar")}
                selectedKey={settings.titlebar}
                onSelectionChange={onTitlebarChange}
                triggerClassName={SELECT_TRIGGER}
              >
                <SelectItem id="native">{t("settings.titlebarNative")}</SelectItem>
                <SelectItem id="mac">{t("settings.titlebarMac")}</SelectItem>
              </Select>
              <Button
                size="small"
                variant="ghost"
                disabled={
                  restartPending ||
                  decorated === null ||
                  (settings.titlebar === "native") === decorated
                }
                onClick={() => void onRestart()}
              >
                {t("settings.restartNow")}
              </Button>
            </div>
          </SettingsRow>
        )}
        <SettingsRow anchor="language" label={t("settings.language")}>
          <Select
            aria-label={t("settings.language")}
            selectedKey={settings.language}
            onSelectionChange={onLanguageChange}
            triggerClassName={SELECT_TRIGGER}
          >
            <SelectItem id="zh">{t("settings.langZh")}</SelectItem>
            <SelectItem id="en">{t("settings.langEn")}</SelectItem>
          </Select>
        </SettingsRow>
        <ZoomRow />
        <FontFamilyRow
          anchor="fontFamily"
          label={t("settings.fontFamily")}
          value={settings.fontFamily ?? ""}
          filePath={settings.fontFile ?? ""}
          busy={fontBusy === "fontFamily"}
          onModeChange={(mode) => onFontModeChange("fontFamily", mode)}
          onPickFile={() => onFontFilePick("fontFamily")}
        />
        <FontFamilyRow
          anchor="codeFontFamily"
          label={t("settings.codeFontFamily")}
          description={t("settings.codeFontFamilyDesc")}
          value={settings.codeFontFamily ?? ""}
          filePath={settings.codeFontFile ?? ""}
          busy={fontBusy === "codeFontFamily"}
          onModeChange={(mode) => onFontModeChange("codeFontFamily", mode)}
          onPickFile={() => onFontFilePick("codeFontFamily")}
        />
        <SettingsRow anchor="sidebarThreadLimit" label={t("settings.sidebarThreadLimit")}>
          <Input
            aria-label={t("settings.sidebarThreadLimit")}
            size="small"
            className="w-20"
            inputClassName="text-center"
            inputMode="numeric"
            value={
              limitText ??
              String(settings.sidebarThreadLimit ?? THREAD_LIMIT_DEFAULT)
            }
            onChange={onThreadLimitChange}
            onBlur={onThreadLimitCommit}
            onKeyDown={onThreadLimitKeyDown}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

/** Interface zoom select; shares the status bar's stored percent via the
 *  zoom-change event, so ± buttons, shortcuts and this row never disagree. */
function ZoomRow() {
  const { t } = useTranslation();
  const [pct, setPct] = useState(readZoomPct);
  useEffect(() => onZoomChange(setPct), []);
  return (
    <SettingsRow
      anchor="uiZoom"
      label={t("settings.uiZoom")}
      description={t("settings.uiZoomDesc")}
    >
      <Select
        aria-label={t("settings.uiZoom")}
        selectedKey={String(pct)}
        onSelectionChange={(key) => {
          if (key != null) changeZoom(Number(key));
        }}
        triggerClassName={SELECT_TRIGGER}
      >
        {ZOOM_PRESETS.map((value) => (
          <SelectItem key={value} id={String(value)} textValue={`${value}%`}>
            {value}%
          </SelectItem>
        ))}
      </Select>
    </SettingsRow>
  );
}

/** One font row (界面字体 / 代码字体): 系统默认 / 自定义 select. 自定义 shows
 *  a file picker instead of a family list — the picked file is read through
 *  the backend, registered as this row's custom family (font.ts) and applied
 *  at once; the path stays in settings, so returning to 自定义 re-applies it
 *  without uploading again. `customActive` pins the mode select on 自定义
 *  while no file has been picked yet (the stored value is still the old
 *  mode). Web access has no native dialog (and no local file to read), so the
 *  custom option only exists on desktop. */
function FontFamilyRow({
  anchor,
  label,
  description,
  value,
  filePath,
  busy,
  onModeChange,
  onPickFile,
}: {
  anchor: string;
  label: string;
  description?: string;
  value: string;
  filePath: string;
  busy: boolean;
  onModeChange: (value: string) => void;
  onPickFile: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [customActive, setCustomActive] = useState(false);
  const canCustomize = !isWeb;
  const isCustomValue = canCustomize && normalizeFontMode(value) === CUSTOM_FONT_VALUE;
  const custom = customActive || isCustomValue;
  const mode = custom ? "custom" : "default";

  return (
    <SettingsRow anchor={anchor} label={label} description={description}>
      <div className="flex items-center gap-2">
        <Select
          aria-label={label}
          selectedKey={mode}
          onSelectionChange={(key) => {
            if (key == null) return;
            const next = String(key);
            if (next === "custom") {
              setCustomActive(true);
              // 已上传过文件：直接重新应用，不必再选一次。
              if (filePath) onModeChange("custom");
              return;
            }
            setCustomActive(false);
            onModeChange("");
          }}
          triggerClassName={SELECT_TRIGGER}
        >
          <SelectItem id="default">{t("settings.fontDefault")}</SelectItem>
          {canCustomize && <SelectItem id="custom">{t("settings.fontCustom")}</SelectItem>}
        </Select>
        {custom && (
          <Button
            size="small"
            variant="secondary"
            leadingIcon={Upload}
            disabled={busy}
            onClick={() => {
              void onPickFile().then((picked) => {
                if (picked) setCustomActive(false);
              });
            }}
          >
            <span className="block max-w-56 truncate" title={filePath || undefined}>
              {filePath ? fileName(filePath) : t("settings.fontChooseFile")}
            </span>
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}

/** Last path segment for the picker button label (both separators). */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Behavior card: composer send shortcut, thinking auto-collapse, session
 *  auto-naming, prompt history. */
function BehaviorCard({
  settings,
  onSendShortcutChange,
  onThinkingAutoCollapseChange,
  onAutoTitleEnabledChange,
  onAutoTitleModelChange,
  onAutoTitleEffortChange,
}: {
  settings: AppSettings;
  onSendShortcutChange: (key: Key | null) => void;
  onThinkingAutoCollapseChange: (autoCollapse: boolean) => void;
  onAutoTitleEnabledChange: (enabled: boolean) => void;
  onAutoTitleModelChange: (model: AutoTitleModel) => void;
  onAutoTitleEffortChange: (key: Key | null) => void;
}) {
  const { t } = useTranslation();
  const autoTitleEnabled = settings.autoTitleEnabled ?? false;
  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("settings.behavior")}</SettingsSectionLabel>
      <SettingsCard>
        <SettingsRow anchor="sendShortcut" label={t("settings.sendShortcut")}>
          <Select
            aria-label={t("settings.sendShortcut")}
            selectedKey={settings.composerSendShortcut ?? "enter"}
            onSelectionChange={onSendShortcutChange}
            triggerClassName={SELECT_TRIGGER}
          >
            <SelectItem id="enter">{t("settings.sendShortcutEnter")}</SelectItem>
            {/* macOS sends with ⌘+Enter, other platforms Ctrl+Enter
                (composer-editable reads metaKey || ctrlKey). */}
            <SelectItem id="cmdEnter">
              {t(navigator.platform.includes("Mac")
                ? "settings.sendShortcutCmdEnter"
                : "settings.sendShortcutCmdEnterCtrl")}
            </SelectItem>
          </Select>
        </SettingsRow>

        <SettingsRow
          anchor="thinkingAutoCollapse"
          label={t("settings.thinkingAutoCollapse")}
          description={t("settings.thinkingAutoCollapseDesc")}
        >
          <Switch
            size="sm"
            aria-label={t("settings.thinkingAutoCollapse")}
            isSelected={settings.thinkingAutoCollapse ?? true}
            onChange={onThinkingAutoCollapseChange}
          />
        </SettingsRow>

        <SettingsRow
          anchor="autoTitle"
          label={t("settings.autoTitle")}
          description={t("settings.autoTitleDesc")}
        >
          <Switch
            size="sm"
            aria-label={t("settings.autoTitle")}
            isSelected={autoTitleEnabled}
            onChange={onAutoTitleEnabledChange}
          />
        </SettingsRow>
        <AutoTitleModelSettings settings={settings}
          onModelChange={onAutoTitleModelChange} onEffortChange={onAutoTitleEffortChange} />
        <PromptHistoryToggleRow />
      </SettingsCard>
    </div>
  );
}

/** General page: appearance (theme/language/thread limit) + behavior
 *  (composer send shortcut). */
export function GeneralSection() {
  const { t } = useTranslation();
  const {
    settings,
    error,
    limitText,
    decorated,
    restartPending,
    onThemeChange,
    onTitlebarChange,
    onRestart,
    onLanguageChange,
    onThreadLimitChange,
    commitThreadLimitText,
    onThreadLimitKeyDown,
    onSendShortcutChange,
    onThinkingAutoCollapseChange,
    onAutoTitleEnabledChange,
    onAutoTitleModelChange,
    onAutoTitleEffortChange,
    fontBusy,
    onFontModeChange,
    onFontFilePick,
  } = useGeneralSettingsState();

  return (
    <div className="flex w-full flex-col gap-6">
      {error && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      {!settings && !error && (
        <p className="text-body-regular text-text-tertiary">{t("common.loading")}</p>
      )}
      {settings && (
        <AppearanceCard
          settings={settings}
          limitText={limitText}
          decorated={decorated}
          restartPending={restartPending}
          fontBusy={fontBusy}
          onThemeChange={onThemeChange}
          onTitlebarChange={onTitlebarChange}
          onRestart={onRestart}
          onLanguageChange={onLanguageChange}
          onFontModeChange={onFontModeChange}
          onFontFilePick={onFontFilePick}
          onThreadLimitChange={onThreadLimitChange}
          onThreadLimitCommit={commitThreadLimitText}
          onThreadLimitKeyDown={onThreadLimitKeyDown}
        />
      )}
      {settings && (
        <BehaviorCard
          settings={settings}
          onSendShortcutChange={onSendShortcutChange}
          onThinkingAutoCollapseChange={onThinkingAutoCollapseChange}
          onAutoTitleEnabledChange={onAutoTitleEnabledChange}
          onAutoTitleModelChange={onAutoTitleModelChange}
          onAutoTitleEffortChange={onAutoTitleEffortChange}
        />
      )}
      {settings && <PromptHistoryManager />}
    </div>
  );
}
