import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import { Input } from "@/components/base/input/input";
import { Kbd } from "@/components/base/kbd";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type AppSettings } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import {
  defaultShortcutFor,
  resolveShortcut,
  shortcutActions,
  type ShortcutAction,
  type ShortcutCategory,
  type ShortcutSettingKey,
} from "./actions";
import {
  buildShortcutValue,
  formatShortcutForPlatform,
  splitShortcutForPlatform,
} from "./shortcuts";

/** 分组展示顺序。 */
const CATEGORY_ORDER: ShortcutCategory[] = [
  "sessions",
  "app",
  "panels",
  "editor",
  "view",
];

/** 键位 chips：可解析拆成修饰键+主键，否则整体展示格式化文本。 */
function ShortcutChips({ value }: { value: string }) {
  const keys = splitShortcutForPlatform(value);
  if (!keys) {
    return (
      <span className="text-body-2-regular text-text-secondary">
        {formatShortcutForPlatform(value)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((part) => (
        <Kbd key={part}>{part}</Kbd>
      ))}
    </span>
  );
}

/**
 * 设置 → 快捷键：shortcutActions 元数据表的编辑面。录制式编辑——聚焦按键
 * 框后按下新组合保存，Backspace/Delete 清除（不绑定），Esc 取消；录制时
 * 做冲突检测（旧版 desktop-cc-gui 没有，重复键会让后注册的 handler 静默
 * 失效）。「重置」写回默认键位。
 */
export function ShortcutsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [conflictById, setConflictById] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void ipc
      .getAppSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Read-modify-write onto a fresh read so concurrent edits elsewhere
  // (general page, CLI pages) aren't clobbered. The runtime picks the change
  // up via the backend's settings://changed event.
  const save = useCallback(async (patch: Partial<AppSettings>) => {
    const latest = await ipc.getAppSettings();
    const next = { ...latest, ...patch };
    await ipc.updateAppSettings(next);
    setSettings(next);
  }, []);

  const setShortcut = useCallback(
    (setting: ShortcutSettingKey, value: string | null) => {
      void save({ [setting]: value }).catch(() => {});
    },
    [save],
  );

  const effectiveValues = useMemo(() => {
    const raw = settings ?? {};
    const values: Record<string, string | null> = {};
    for (const action of shortcutActions) {
      values[action.id] = resolveShortcut(action, raw);
    }
    return values;
  }, [settings]);

  const normalizedQuery = query.trim().toLowerCase();
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    actions: shortcutActions.filter(
      (action) =>
        action.category === category &&
        (!normalizedQuery ||
          t(action.labelKey).toLowerCase().includes(normalizedQuery)),
    ),
  })).filter((group) => group.actions.length > 0);

  const handleRecordKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    action: ShortcutAction,
  ) => {
    // Tab 放行（保留表单导航）；shift+tab 可被 buildShortcutValue 录入。
    if (event.key === "Tab" && !event.shiftKey) return;
    event.preventDefault();
    if (event.key === "Escape") {
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      // 空字符串 = 显式不绑定（区别于 null/未设置的回退默认）。
      setShortcut(action.setting, "");
      setConflictById((prev) => ({ ...prev, [action.id]: "" }));
      event.currentTarget.blur();
      return;
    }
    const value = buildShortcutValue(event.nativeEvent);
    if (!value) return;
    const conflict = shortcutActions.find(
      (other) => other.id !== action.id && effectiveValues[other.id] === value,
    );
    if (conflict) {
      setConflictById((prev) => ({
        ...prev,
        [action.id]: t("shortcuts.conflict", {
          action: t(conflict.labelKey),
        }),
      }));
      event.currentTarget.blur();
      return;
    }
    setConflictById((prev) => ({ ...prev, [action.id]: "" }));
    setShortcut(action.setting, value);
    event.currentTarget.blur();
  };

  const resetAll = () => {
    const patch: Partial<AppSettings> = {};
    for (const action of shortcutActions) {
      (patch as Record<string, string | null>)[action.setting] =
        defaultShortcutFor(action) ?? "";
    }
    void save(patch).catch(() => {});
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            value={query}
            onChange={(value) => setQuery(value)}
            placeholder={t("shortcuts.searchPlaceholder")}
            aria-label={t("shortcuts.searchPlaceholder")}
          />
        </div>
        <button
          type="button"
          onClick={resetAll}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {t("shortcuts.resetAll")}
        </button>
      </div>
      <p className="px-3 text-body-2-regular text-text-tertiary">
        {t("shortcuts.sectionDesc")}
      </p>
      {groups.length === 0 && (
        <p className="px-3 py-6 text-center text-body-2-regular text-text-tertiary">
          {t("shortcuts.empty")}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.category} className="flex flex-col gap-2">
          <SettingsSectionLabel>
            {t(`shortcuts.groups.${group.category}`)}
          </SettingsSectionLabel>
          <SettingsCard>
            {group.actions.map((action) => {
              const value = effectiveValues[action.id];
              const recording = recordingId === action.id;
              const conflict = conflictById[action.id];
              const isDefault = value === defaultShortcutFor(action);
              return (
                <SettingsRow
                  key={action.id}
                  anchor={action.id}
                  label={t(action.labelKey)}
                  description={conflict || undefined}
                >
                  <span className="flex shrink-0 items-center gap-1.5">
                    {!isDefault && !recording && (
                      <button
                        type="button"
                        aria-label={t("shortcuts.reset")}
                        title={t("shortcuts.reset")}
                        onClick={() =>
                          setShortcut(
                            action.setting,
                            defaultShortcutFor(action) ?? "",
                          )
                        }
                        className="flex size-7 items-center justify-center rounded-lg text-foreground-icon-tertiary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                      </button>
                    )}
                    <button
                      type="button"
                      onFocus={() => setRecordingId(action.id)}
                      onBlur={() =>
                        setRecordingId((cur) => (cur === action.id ? null : cur))
                      }
                      onKeyDown={(event) => handleRecordKeyDown(event, action)}
                      title={t("shortcuts.clearTooltip")}
                      className={cx(
                        "flex h-8 min-w-20 items-center justify-center rounded-lg border px-2 outline-none transition-colors",
                        recording
                          ? "border-border-brand-solid bg-background-primary-default text-text-secondary"
                          : "border-border-button-default bg-background-primary-default hover:bg-background-secondary-hover",
                      )}
                    >
                      {recording ? (
                        <span className="text-body-2-regular text-text-tertiary">
                          {t("shortcuts.recordHint")}
                        </span>
                      ) : value ? (
                        <ShortcutChips value={value} />
                      ) : (
                        <span className="text-body-2-regular text-text-tertiary">
                          {t("shortcuts.notSet")}
                        </span>
                      )}
                    </button>
                  </span>
                </SettingsRow>
              );
            })}
          </SettingsCard>
        </div>
      ))}
    </div>
  );
}
