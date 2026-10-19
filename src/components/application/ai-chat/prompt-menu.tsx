"use client";

import { memo, useEffect, useMemo, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import {
  ComposerPickerMenu,
  PickerOption,
  type ComposerPickerMenuHandle,
} from "@/components/application/ai-chat/composer-picker-menu";
import { matchPrompts, usePromptStore } from "@/features/prompts/prompt-store";
import { type CustomPromptEntry } from "@/lib/ipc";

/**
 * `!` picker, rendered above the composer while a `!` trigger is active.
 * Rows are the workspace + global custom prompts (name + description +
 * scope badge); a fixed "new prompt" footer row jumps to the settings
 * page. Thin shell over ComposerPickerMenu — the contentEditable keeps
 * focus and owns the keyboard; keys arrive through menuRef.
 */

/** Imperative key handling for the composer's keydown handler. */
export type PromptMenuHandle = ComposerPickerMenuHandle;

/** Sentinel path of the fixed footer row that opens the settings page. */
export const CREATE_NEW_PROMPT_PATH = "__create_new__";

const Row = memo(function Row({
  entry,
  index,
  active,
  scopeLabel,
  onSelect,
  onHover,
}: {
  entry: CustomPromptEntry;
  index: number;
  active: boolean;
  /** Short scope badge ("工作区" / "全局"); keeps workspace and global
   *  prompts visually distinct. */
  scopeLabel: string;
  onSelect: (entry: CustomPromptEntry) => void;
  onHover: (index: number) => void;
}) {
  if (entry.path === CREATE_NEW_PROMPT_PATH) {
    return (
      <PickerOption
        active={active}
        onSelect={() => onSelect(entry)}
        onHover={() => onHover(index)}
      >
        <Plus aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
        <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
      </PickerOption>
    );
  }
  const description = entry.description ?? "";
  return (
    <PickerOption
      active={active}
      onSelect={() => onSelect(entry)}
      onHover={() => onHover(index)}
    >
      <span className="shrink-0 font-mono text-body-regular text-text-primary">
        {entry.name}
      </span>
      {description && (
        <span
          className="truncate text-body-regular text-text-tertiary"
          title={description}
        >
          {description}
        </span>
      )}
      <span className="ml-auto shrink-0 text-caption-1-regular text-text-tertiary">
        {scopeLabel}
      </span>
    </PickerOption>
  );
});

export function PromptMenu({
  root,
  query,
  /** Horizontal offset (px) of the `!` caret inside the composer wrapper. */
  left,
  onSelect,
  onClose,
  menuRef,
}: {
  root: string;
  query: string;
  left: number;
  onSelect: (entry: CustomPromptEntry) => void;
  onClose: () => void;
  menuRef?: MutableRefObject<PromptMenuHandle | null>;
}) {
  const { t } = useTranslation();
  const catalog = usePromptStore((s) => (root ? s.byRoot[root] : undefined));
  useEffect(() => {
    if (root) usePromptStore.getState().ensure(root);
  }, [root]);

  const matched = useMemo(
    () => matchPrompts(catalog?.entries ?? [], query),
    [catalog?.entries, query],
  );
  const items = useMemo<CustomPromptEntry[]>(
    () => [
      ...matched,
      {
        name: t("chat.promptCreate"),
        path: CREATE_NEW_PROMPT_PATH,
        content: "",
        scope: "workspace",
      },
    ],
    [matched, t],
  );

  return (
    <ComposerPickerMenu
      left={left}
      width="w-[420px]"
      ariaLabel={t("chat.prompts")}
      scope={`${root}\n${query}`}
      loading={matched.length === 0 && (!catalog || catalog.status === "loading")}
      loadingText={t("chat.promptsLoading")}
      emptyText={t("chat.promptsEmpty")}
      items={items}
      rowKey={(entry) => entry.path}
      onSelect={onSelect}
      onClose={onClose}
      menuRef={menuRef}
      groupHeaderAt={(_entry, i) =>
        // No prompt rows (the create row sits alone): paint the empty hint
        // as a non-selectable header above it.
        i === 0 && matched.length === 0 ? (
          <div className="px-2 pb-1 pt-1.5 text-caption-1-medium text-text-tertiary select-none">
            {t("chat.promptsEmpty")}
          </div>
        ) : null
      }
      renderRow={(entry, i, active, { onHover }) => (
        <Row
          entry={entry}
          index={i}
          active={active}
          scopeLabel={
            entry.scope === "global"
              ? t("chat.promptScopeGlobal")
              : t("chat.promptScopeWorkspace")
          }
          onSelect={onSelect}
          onHover={onHover}
        />
      )}
    />
  );
}
