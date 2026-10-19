import X from "lucide-react/dist/esm/icons/x";
import { useTranslation } from "react-i18next";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "@/utils/cx";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import type { ActiveSession } from "../store/persistence";

export interface SessionTabItem {
  key: string;
  label: string;
  streaming: boolean;
  /** 会话页签的会话身份：向下拖出页签条分屏时用它作为拖拽载荷。
   *  非会话页签（文件/浏览器/插件/差异）没有这个字段。 */
  session?: ActiveSession;
  /** Provider backoff on the running turn — keep the dot but stop its pulse. */
  retrying?: boolean;
  /** Engine (CLI) id, shown as a brand mark before the label. */
  engine?: string;
  /** Icon for non-session tabs (e.g. files); takes precedence over engine. */
  icon?: LucideIcon;
  /** Finished activity the user has not opened yet — solid green dot. */
  unseen?: boolean;
  /** 待读的非会话提醒（如升级后的「新版本」）：强调色圆点，值就是它的
   *  可访问名与悬停提示。 */
  unread?: string;
  /** Unsaved-changes dot before the label. */
  dirty?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
}

/** Custom tab icon when provided, else the engine brand mark. */
function TabLeadingIcon({
  icon: Icon,
  engine,
}: {
  icon?: LucideIcon;
  engine?: string;
}) {
  if (Icon) {
    return (
      <Icon
        className="size-3 shrink-0 text-foreground-icon-secondary"
        aria-hidden
      />
    );
  }
  return (
    <EngineIcon
      engine={engine ?? ""}
      size={12}
      className="size-3 shrink-0 text-foreground-icon-secondary"
    />
  );
}

/** Same status dots as the sidebar: breathing blue while the turn streams,
 * solid green for unseen finished activity, accent for a pending notice the
 * user has not read yet (the release-notes tab's new version). */
function TabStatusDot({
  streaming,
  retrying,
  unseen,
  unread,
}: {
  streaming: boolean;
  retrying?: boolean;
  unseen?: boolean;
  unread?: string;
}) {
  const { t } = useTranslation();
  if (streaming) {
    return (
      <span
        className={cx(
          "sidebar-thread-status sidebar-thread-status-processing",
          retrying && "sidebar-thread-status-retrying",
        )}
        role="status"
        aria-label={t("chat.sessionRunning")}
        title={t("chat.sessionRunning")}
      />
    );
  }
  if (unseen) {
    return (
      <span
        className="sidebar-thread-status sidebar-thread-status-unseen"
        aria-label={t("chat.sessionUnseen")}
        title={t("chat.sessionUnseen")}
      />
    );
  }
  if (unread) {
    return (
      <span
        className="size-1.5 shrink-0 rounded-full bg-accent-500"
        role="status"
        aria-label={unread}
        title={unread}
      />
    );
  }
  return null;
}

/** One tab in the strip: icon, status dots, label, drop indicator, close
 * button. Selection lives on the tab; the close button sits beside it so no
 * focusable control nests inside the tab. */
export function SessionTab({
  tab,
  isActive,
  dragged,
  dropBefore,
  closeLabel,
  onShowMenu,
  onSelect,
  onClose,
  onPointerDown,
  suppressClickRef,
}: {
  tab: SessionTabItem;
  isActive: boolean;
  /** This tab is the one being drag-reordered. */
  dragged: boolean;
  /** Drop indicator side, null when this tab is not the drop target. */
  dropBefore: boolean | null;
  closeLabel: string;
  /** Right-click menu anchor; omitted when the strip has no tab menu. */
  onShowMenu?: (position: { x: number; y: number }) => void;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  suppressClickRef: React.MutableRefObject<boolean>;
}) {
  return (
    <div
      data-tab-key={tab.key}
      role="presentation"
      title={tab.title ?? tab.label}
      onContextMenu={(e) => {
        if (!onShowMenu) return;
        e.preventDefault();
        onShowMenu({ x: e.clientX, y: e.clientY });
      }}
      className={cx(
        "group relative flex h-7 max-w-48 shrink-0 cursor-default items-center gap-1.5 rounded-lg px-2.5 text-body-medium transition-colors",
        dragged && "opacity-50",
        isActive
          ? "bg-background-secondary-default text-text-primary"
          : "text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary",
      )}
    >
      <div
        role="tab"
        aria-selected={isActive}
        aria-controls="center-tabpanel"
        tabIndex={isActive ? 0 : -1}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onSelect(tab.key);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(tab.key);
          }
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onClose(tab.key);
        }}
        onPointerDown={onPointerDown}
        className="flex min-w-0 flex-1 cursor-default items-center gap-1.5"
      >
        <TabLeadingIcon icon={tab.icon} engine={tab.engine} />
        <TabStatusDot streaming={tab.streaming} retrying={tab.retrying} unseen={tab.unseen} unread={tab.unread} />
        {tab.dirty && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-icon-primary" />
        )}
        <span className="truncate">{tab.label}</span>
      </div>
      {dropBefore !== null && (
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-accent-500",
            dropBefore ? "-left-[3px]" : "-right-[3px]",
          )}
        />
      )}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.key);
        }}
        className={cx(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-tertiary-hover hover:text-foreground-icon-primary",
          // Keyboard users must see the button when it has focus, not
          // only on pointer hover.
          isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
