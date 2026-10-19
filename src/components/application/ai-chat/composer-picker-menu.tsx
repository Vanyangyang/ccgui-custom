"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  MENU_ITEM,
  MENU_ITEM_ACTIVE,
  MENU_ITEMS_CONTAINER,
  menuPopoverSurface,
} from "@/components/base/dropdown/menu-styles";
import { cx } from "@/utils/cx";

/**
 * ComposerPickerMenu — shared menu surface for the composer's trigger
 * pickers (`@` file mentions, `/` commands), rendered above the composer
 * while a trigger is active. The contentEditable keeps focus and owns the
 * keyboard; the menu is deliberately NOT a react-aria popover (those steal
 * focus / manage their own trigger) — the composer forwards keys through
 * `menuRef` instead. Each picker supplies its own row content via
 * `renderRow` and optional group headers via `groupHeaderAt`.
 */

/** Imperative key handling for the composer's keydown handler. */
export interface ComposerPickerMenuHandle {
  /** Returns true when the menu consumed the key (caller preventDefaults). */
  handleKey: (key: string) => boolean;
}

/**
 * PickerOption — the option row shell shared by the composer pickers: ARIA
 * option semantics plus the pointer/keyboard handlers. Row content stays
 * with each picker. Keyboard focus stays in the composer by design (keys
 * are forwarded through menuRef); tabIndex={-1} keeps the option
 * programmatically focusable without joining the tab order, and Enter/Space
 * mirror the click for any AT that does move focus here.
 */
export function PickerOption({
  active,
  onSelect,
  onHover,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      tabIndex={-1}
      // Keep the contentEditable selection: the composer closes the menu when
      // the caret leaves the trigger, and focus must not move mid-click.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => {
        if (!active) onHover();
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cx(MENU_ITEM, active && MENU_ITEM_ACTIVE)}
    >
      {children}
    </div>
  );
}

export function ComposerPickerMenu<T>({
  left,
  width,
  ariaLabel,
  scope,
  loading,
  loadingText,
  emptyText,
  items,
  rowKey,
  renderRow,
  groupHeaderAt,
  onSelect,
  onClose,
  menuRef,
}: {
  /** Horizontal offset (px) of the trigger caret inside the composer wrapper. */
  left: number;
  /** Literal Tailwind width class — the scanner never sees interpolation. */
  width: string;
  ariaLabel: string;
  /** Trigger scope (query + root): the highlight resets to the top match
   *  whenever this changes. */
  scope: string;
  /** The cache is on its first fetch and nothing matches yet. */
  loading: boolean;
  loadingText: string;
  emptyText: string;
  items: T[];
  rowKey: (item: T) => string;
  renderRow: (
    item: T,
    index: number,
    active: boolean,
    handlers: { onSelect: (item: T) => void; onHover: (index: number) => void },
  ) => ReactNode;
  /** Section header rendered above a row at group boundaries (return null
   *  elsewhere); keyboard navigation skips headers — they are not options,
   *  so row indices stay contiguous. */
  groupHeaderAt?: (item: T, index: number, items: T[]) => ReactNode;
  onSelect: (item: T) => void;
  onClose: () => void;
  menuRef?: MutableRefObject<ComposerPickerMenuHandle | null>;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  // New scope (query/root) → highlight the top match again: render-time
  // adjustment via prev-prop comparison instead of a cascading effect.
  const [prevScope, setPrevScope] = useState(scope);
  if (prevScope !== scope) {
    setPrevScope(scope);
    setActiveIndex(0);
  }
  const active = items.length > 0 ? Math.min(activeIndex, items.length - 1) : -1;

  // Keep the highlighted row in view while arrowing.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  const handleKey = useCallback(
    (key: string): boolean => {
      switch (key) {
        case "ArrowDown":
        case "ArrowUp": {
          // Swallow even with no matches: the history nav must not hijack
          // arrows while the picker is open.
          if (items.length === 0) return true;
          const delta = key === "ArrowDown" ? 1 : -1;
          setActiveIndex((i) =>
            (Math.min(i, items.length - 1) + delta + items.length) % items.length,
          );
          return true;
        }
        case "Enter":
        case "Tab": {
          const item = active >= 0 ? items[active] : undefined;
          if (!item) return false; // fall through to send / ghost completion
          onSelect(item);
          return true;
        }
        case "Escape":
          onClose();
          return true;
        default:
          return false;
      }
    },
    [items, active, onSelect, onClose],
  );

  // Expose the key handle (same ref-prop pattern as ComposerInputHandle).
  useEffect(() => {
    if (!menuRef) return;
    const handle: ComposerPickerMenuHandle = { handleKey };
    menuRef.current = handle;
    return () => {
      if (menuRef.current === handle) menuRef.current = null;
    };
  }, [menuRef, handleKey]);

  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      className={cx(
        menuPopoverSurface({ width, origin: "origin-bottom-left", padding: "p-1.5" }),
        "absolute bottom-full z-20 mb-2",
      )}
      style={{ left }}
    >
      <div ref={listRef} className={cx(MENU_ITEMS_CONTAINER, "max-h-[300px] overflow-y-auto")}>
        {loading ? (
          <div className="p-2 text-body-regular text-text-tertiary select-none">
            {loadingText}
          </div>
        ) : items.length === 0 ? (
          <div className="p-2 text-body-regular text-text-tertiary select-none">
            {emptyText}
          </div>
        ) : (
          items.map((item, i) => {
            const row = renderRow(item, i, i === active, {
              onSelect,
              onHover: setActiveIndex,
            });
            if (!groupHeaderAt) return <Fragment key={rowKey(item)}>{row}</Fragment>;
            return (
              <div key={rowKey(item)}>
                {groupHeaderAt(item, i, items)}
                {row}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
