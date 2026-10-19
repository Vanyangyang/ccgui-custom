"use client";

import {
  memo,
  useEffect,
  useMemo,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Zap from "lucide-react/dist/esm/icons/zap";
import {
  ComposerPickerMenu,
  PickerOption,
  type ComposerPickerMenuHandle,
} from "@/components/application/ai-chat/composer-picker-menu";
import {
  matchSlashCommands,
  useSlashCommandStore,
} from "./slash-commands";
import { matchAppCommands } from "./app-commands";
import { type SlashCommandEntry } from "@/lib/ipc";

/**
 * `/` picker, rendered above the composer while a `/` trigger is active.
 * Lists two distinct entry kinds — slash commands and skills — grouped by
 * kind with per-kind icons/badges. Same interaction model as
 * FileMentionMenu (both are thin shells over ComposerPickerMenu): the
 * contentEditable keeps focus and owns the keyboard; the menu is
 * deliberately NOT a react-aria popover (those steal focus / manage their
 * own trigger) — the composer forwards keys through `menuRef` instead.
 */

/** Imperative key handling for the composer's keydown handler. */
export type SlashCommandMenuHandle = ComposerPickerMenuHandle;

/** Section header between kind groups; keyboard navigation skips it
 *  (headers are not options — Row indices stay contiguous). */
const GROUP_HEADER =
  "px-2 pb-1 pt-1.5 text-caption-1-medium text-text-tertiary select-none";

const Row = memo(function Row({
  entry,
  index,
  active,
  kindLabel,
  onSelect,
  onHover,
}: {
  entry: SlashCommandEntry;
  index: number;
  active: boolean;
  /** Short kind badge ("命令" / "技能"); keeps commands and skills
   *  visually distinct even when their icons scroll past. */
  kindLabel: string;
  onSelect: (entry: SlashCommandEntry) => void;
  onHover: (index: number) => void;
}) {
  const description = entry.description ?? "";
  const Icon =
    entry.kind === "skill" ? Sparkles : entry.kind === "app" ? Zap : Terminal;
  return (
    <PickerOption
      active={active}
      onSelect={() => onSelect(entry)}
      onHover={() => onHover(index)}
    >
      <Icon
        aria-hidden
        className="size-4 shrink-0 text-foreground-icon-secondary"
      />
      <span className="shrink-0 font-mono text-body-regular text-text-primary">
        /{entry.name}
      </span>
      {description && (
        <span className="truncate text-body-regular text-text-tertiary" title={description}>
          {description}
        </span>
      )}
      <span className="ml-auto shrink-0 text-caption-1-regular text-text-tertiary">
        {kindLabel}
      </span>
    </PickerOption>
  );
});

export function SlashCommandMenu({
  root,
  query,
  /** Horizontal offset (px) of the `/` caret inside the composer wrapper. */
  left,
  onSelect,
  onClose,
  menuRef,
}: {
  root: string;
  query: string;
  left: number;
  onSelect: (entry: SlashCommandEntry) => void;
  onClose: () => void;
  menuRef?: MutableRefObject<SlashCommandMenuHandle | null>;
}) {
  const { t } = useTranslation();
  const catalog = useSlashCommandStore((s) => (root ? s.byRoot[root] : undefined));
  useEffect(() => {
    if (root) useSlashCommandStore.getState().ensure(root);
  }, [root]);

  const entries = catalog?.entries;
  const items = useMemo(
    // Built-in app commands lead the list; a catalog command of the same
    // name shadows its app row (precedence parity with submit interception).
    () => [...matchAppCommands(entries, query), ...matchSlashCommands(entries ?? [], query)],
    [entries, query],
  );

  return (
    <ComposerPickerMenu
      left={left}
      width="w-[420px]"
      ariaLabel={t("chat.slashCommands")}
      scope={`${root}\n${query}`}
      loading={catalog?.status === "loading" && items.length === 0}
      loadingText={t("chat.slashLoading")}
      emptyText={t("chat.slashNoMatches")}
      items={items}
      rowKey={(entry) => `${entry.kind}:${entry.source}:${entry.name}`}
      onSelect={onSelect}
      onClose={onClose}
      menuRef={menuRef}
      groupHeaderAt={(entry, i) =>
        // Group header at each kind boundary (app rows lead, then the
        // catalog's commands-then-skills).
        i === 0 || items[i - 1].kind !== entry.kind ? (
          <div className={GROUP_HEADER}>
            {entry.kind === "app"
              ? t("chat.slashGroupApp")
              : entry.kind === "skill"
                ? t("chat.slashGroupSkills")
                : t("chat.slashGroupCommands")}
          </div>
        ) : null
      }
      renderRow={(entry, i, active, { onHover }) => (
        <Row
          entry={entry}
          index={i}
          active={active}
          kindLabel={
            entry.kind === "app"
              ? t("chat.slashKindApp")
              : entry.kind === "skill"
                ? t("chat.slashKindSkill")
                : t("chat.slashKindCommand")
          }
          onSelect={onSelect}
          onHover={onHover}
        />
      )}
    />
  );
}
