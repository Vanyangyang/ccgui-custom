import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Search from "lucide-react/dist/esm/icons/search";
import { cx } from "@/utils/cx";
import {
  MENU_ITEM,
  MENU_ITEM_ACTIVE,
  MENU_ITEMS_CONTAINER,
} from "@/components/base/dropdown/menu-styles";
import {
  useMentionIndexStore,
  type MentionEntry,
} from "@/components/application/ai-chat/mention-files";
import { getFileTreeIconSvg } from "./fileIcons";
import { searchEntries } from "./file-search";
import { joinPath, useFilesStore } from "./store";

const INPUT_ID = "file-search-input";

/**
 * Workspace file search scoped to one folder, opened from the tree's
 * right-click menu. Shares the @-mention index cache for the active
 * workspace root (no extra walk), and exists only while `searchRoot` is set
 * — see FilesPanel. Escape closes; the input keeps focus, so the pointer and
 * the keyboard both work without a focus dance.
 */
export function FileSearchOverlay({ searchRoot }: { searchRoot: string }) {
  const { t } = useTranslation();
  const root = useFilesStore((s) => s.root);
  const closeSearch = useFilesStore((s) => s.closeSearch);
  const index = useMentionIndexStore((s) => (root ? s.byRoot[root] : undefined));
  useEffect(() => {
    if (root) useMentionIndexStore.getState().ensure(root);
  }, [root]);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The overlay mounts per open, so this focuses the input exactly then.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(
    () => searchEntries(index?.entries ?? [], root, searchRoot, query),
    [index, root, searchRoot, query],
  );

  // The match list can shrink under the cursor; clamp the active row.
  const active = items.length > 0 ? Math.min(activeIndex, items.length - 1) : -1;

  const activate = useCallback(
    (entry: MentionEntry) => {
      // Index rels are workspace-relative with "/" — back to the absolute,
      // platform-separator paths the tree/store use.
      const absolute = joinPath(root, entry.rel);
      if (entry.isDir) useFilesStore.getState().selectPath(absolute, true);
      else void useFilesStore.getState().openFile(absolute);
      closeSearch();
    },
    [root, closeSearch],
  );

  // Keys live on the window (same pattern as the command palette): the input
  // holds focus, but the overlay stays keyboard-driven even if focus leaves.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          closeSearch();
          return;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
          return;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        case "Enter": {
          const entry = active >= 0 ? items[active] : undefined;
          if (!entry) return;
          e.preventDefault();
          activate(entry);
          return;
        }
        default:
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, active, activate, closeSearch]);

  // Keep the keyboard-highlighted row in view while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  return (
    <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background-primary-default">
      <div className="flex items-center gap-2 border-b border-separator-border px-3">
        <Search className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden />
        <label
          htmlFor={INPUT_ID}
          className="sr-only"
        >
          {t("files.searchFilesTitle")}
        </label>
        <input
          id={INPUT_ID}
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          placeholder={t("files.searchPlaceholder")}
          className="palette-search-field h-9 w-full bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-placeholder"
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={t("files.searchFilesTitle")}
        className={cx(MENU_ITEMS_CONTAINER, "min-h-0 flex-1 overflow-y-auto p-1.5")}
      >
        {items.length === 0 ? (
          // No query → nothing at all: see searchEntries. A query with no
          // matches gets the empty state.
          query.trim() ? (
            <div className="p-2 text-body-regular text-text-tertiary select-none">
              {t("files.searchNoMatches")}
            </div>
          ) : null
        ) : (
          items.map((entry, i) => {
            // Containing folder ("" for workspace-root entries), same split
            // the @-mention rows use.
            const dir = entry.rel.slice(0, entry.rel.length - entry.name.length);
            return (
              <div
                key={entry.rel}
                role="option"
                aria-selected={i === active}
                data-active={i === active || undefined}
                tabIndex={-1}
                title={entry.rel}
                // Keep focus in the input so typing never stops: the click
                // still activates the row below.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => {
                  if (i !== active) setActiveIndex(i);
                }}
                onClick={() => activate(entry)}
                className={cx(MENU_ITEM, "cursor-pointer", i === active && MENU_ITEM_ACTIVE)}
              >
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center text-foreground-icon-secondary [&>svg]:size-4"
                  dangerouslySetInnerHTML={{
                    __html: getFileTreeIconSvg(entry.name, entry.isDir),
                  }}
                />
                <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
                {dir ? (
                  <span className="truncate text-body-regular text-text-tertiary">{dir}</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
