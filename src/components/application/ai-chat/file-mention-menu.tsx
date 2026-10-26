"use client";

import {
  memo,
  useEffect,
  useMemo,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { getFileTreeIconSvg } from "@/features/files/fileIcons";
import {
  ComposerPickerMenu,
  PickerOption,
  type ComposerPickerMenuHandle,
} from "@/components/application/ai-chat/composer-picker-menu";
import {
  matchProjectMentionEntries,
  ensureMentionRoots,
  useMentionIndexStore,
  type MentionEntry,
} from "./mention-files";
import { useProjectContext } from "@/features/projects/store";

/**
 * @-mention file picker, rendered above the composer while a `@` trigger is
 * active. The contentEditable keeps focus and owns the keyboard; the menu is
 * deliberately NOT a react-aria popover (those steal focus / manage their
 * own trigger) — the composer forwards keys through `menuRef` instead. Thin
 * shell over ComposerPickerMenu: the store subscription, fuzzy match, and
 * row content live here.
 */

/** Imperative key handling for the composer's keydown handler. */
export type FileMentionMenuHandle = ComposerPickerMenuHandle;

const Row = memo(function Row({
  entry,
  index,
  active,
  onSelect,
  onHover,
}: {
  entry: MentionEntry;
  index: number;
  active: boolean;
  onSelect: (entry: MentionEntry) => void;
  onHover: (index: number) => void;
}) {
  const icon = useMemo(
    () => getFileTreeIconSvg(entry.name, entry.isDir),
    [entry.name, entry.isDir],
  );
  // Parent path of the entry ("" for root-level), as the dim right column.
  const dir = entry.rel.slice(0, entry.rel.length - entry.name.length);
  return (
    <PickerOption
      active={active}
      onSelect={() => onSelect(entry)}
      onHover={() => onHover(index)}
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center text-foreground-icon-secondary [&>svg]:size-4"
        dangerouslySetInnerHTML={{ __html: icon }}
      />
      <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
      {(dir || entry.rootLabel) && (
        <span className="truncate text-body-regular text-text-tertiary" title={`${entry.root ?? ""}/${entry.rel}`}>
          {entry.rootLabel ? `${entry.rootLabel} · ` : ""}{dir}
        </span>
      )}
    </PickerOption>
  );
});

export function FileMentionMenu({
  root,
  query,
  /** Horizontal offset (px) of the `@` caret inside the composer wrapper. */
  left,
  onSelect,
  onClose,
  menuRef,
}: {
  root: string;
  query: string;
  left: number;
  onSelect: (entry: MentionEntry) => void;
  onClose: () => void;
  menuRef?: MutableRefObject<FileMentionMenuHandle | null>;
}) {
  const { t } = useTranslation();
  const { roots } = useProjectContext(root);
  const byRoot = useMentionIndexStore((s) => s.byRoot);
  useEffect(() => {
    ensureMentionRoots(roots);
  }, [roots]);

  const items = useMemo(
    () => matchProjectMentionEntries(roots, byRoot, query),
    [roots, byRoot, query],
  );

  return (
    <ComposerPickerMenu
      left={left}
      width="w-[320px]"
      ariaLabel={t("chat.mentionFiles")}
      scope={`${root}\n${query}`}
      loading={roots.some((member) => byRoot[member.path]?.status === "loading") && items.length === 0}
      loadingText={t("chat.mentionIndexing")}
      emptyText={t("chat.mentionNoMatches")}
      items={items}
      rowKey={(entry) => `${entry.root}/${entry.rel}`}
      onSelect={onSelect}
      onClose={onClose}
      menuRef={menuRef}
      renderRow={(entry, i, active, { onHover }) => (
        <Row
          entry={entry}
          index={i}
          active={active}
          onSelect={onSelect}
          onHover={onHover}
        />
      )}
    />
  );
}
