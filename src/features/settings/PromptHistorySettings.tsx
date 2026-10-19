import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { Switch } from "@/components/base/switch/switch";
import { ConfirmDialog } from "@/components/dialogs";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import {
  clearPromptHistory,
  deletePrompt,
  getPromptHistoryWithCounts,
  isPromptHistoryEnabled,
  setPromptHistoryEnabled,
  subscribePromptHistory,
} from "@/features/chat/prompt-history";
import { cx } from "@/utils/cx";

/**
 * Settings entries for composer prompt history (ghost completion + ↑↓
 * recall): a toggle row for the behavior card, and a collapsible manager
 * section listing every recorded prompt with its usage count.
 */

/** Behavior-card row: master switch for completion and history recall. */
export function PromptHistoryToggleRow() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(isPromptHistoryEnabled);
  return (
    <SettingsRow
      anchor="promptHistory"
      label={t("settings.promptHistory")}
      description={t("settings.promptHistoryDesc")}
    >
      <Switch
        size="sm"
        aria-label={t("settings.promptHistory")}
        isSelected={enabled}
        onChange={(next) => {
          setPromptHistoryEnabled(next);
          setEnabled(next);
        }}
      />
    </SettingsRow>
  );
}

/** Standalone section: collapsible list, per-item delete, clear all. */
export function PromptHistoryManager() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(getPromptHistoryWithCounts);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Records land on every submit, so the list must track the store live.
  useEffect(
    () => subscribePromptHistory(() => setEntries(getPromptHistoryWithCounts())),
    [],
  );

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("settings.promptHistoryManage")}</SettingsSectionLabel>
      <SettingsCard>
        <div
          data-setting-anchor="promptHistoryManage"
          className={cx(
            "flex min-h-[52px] w-full cursor-pointer items-center justify-between gap-4 py-2.5 pr-2.5",
            open && entries.length > 0 && "border-b border-separator-border",
          )}
        >
          {/* The toggle is its own button so the clear-all action stays a
              sibling control instead of nesting inside it. */}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
          >
            {open ? (
              <ChevronDown className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
            )}
            <span className="text-body-regular text-text-primary">
              {t("settings.promptHistoryManageTitle", { count: entries.length })}
            </span>
          </button>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingClear(true);
              }}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-body-2-regular text-text-error-primary transition-colors duration-150 ease hover:bg-background-tertiary-hover"
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t("settings.promptHistoryClearAll")}
            </button>
          )}
        </div>

        {open && entries.length === 0 && (
          <p className="py-2.5 pr-2.5 text-body-2-regular text-text-tertiary">
            {t("settings.promptHistoryEmpty")}
          </p>
        )}
        {open &&
          entries.map((entry) => (
            <div
              key={entry.text}
              className="flex items-center gap-2 border-b border-separator-border py-2.5 pr-2.5 last:border-b-0"
            >
              <span className="shrink-0 rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-body-2-regular text-text-secondary">
                [{entry.count}]
              </span>
              <span
                title={entry.text}
                className="min-w-0 flex-1 truncate text-body-regular text-text-primary"
              >
                {entry.text}
              </span>
              <button
                type="button"
                aria-label={t("settings.promptHistoryDelete")}
                onClick={() => deletePrompt(entry.text)}
                className="shrink-0 cursor-pointer rounded-md p-1 text-foreground-icon-secondary transition-colors duration-150 ease hover:bg-background-tertiary-hover"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ))}
      </SettingsCard>

      {confirmingClear && (
        <ConfirmDialog
          danger
          message={t("settings.promptHistoryClearConfirm")}
          onConfirm={() => {
            clearPromptHistory();
            setConfirmingClear(false);
          }}
          onCancel={() => setConfirmingClear(false)}
        />
      )}
    </div>
  );
}
