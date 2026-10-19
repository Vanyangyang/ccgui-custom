import Globe from "lucide-react/dist/esm/icons/globe";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { needsWindowControls, useTitlebarStyle } from "@/features/settings/titlebar";
import { IS_MAC } from "@/lib/platform";
import { WindowControls } from "@/components/application/window-controls";
import { ContextMenu } from "@/components/context-menu";
import { cx } from "@/utils/cx";
import { useOptionalSplitDrag } from "../split/drag";
import { SessionTab, type SessionTabItem } from "./SessionTab";
import { useTabDragReorder } from "./use-tab-drag-reorder";
import { useTabStripChrome } from "./use-tab-strip-chrome";
import { TabStripContextMenu } from "./TabStripContextMenu";

export type { SessionTabItem };

interface SessionTabStripProps {
  tabs: SessionTabItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Tab right-click menu entry: close every tab. Omit to hide the menu. */
  onCloseAll?: () => void;
  /** Tab right-click menu entry: close every tab but the one in view. */
  onCloseInactive?: () => void;
  closeLabel: string;
  /** Drag-reorder: dragged tab key dropped before/after a target tab key. */
  onReorder?: (draggedKey: string, targetKey: string, before: boolean) => void;
  /** Invoked by the trailing "+" button; omit to hide it. */
  onNew?: () => void;
  /** "+" button right-click menu entry: open a browser tab. When set, the
   *  button's context menu offers 新建会话 and 新建浏览器; left-click stays
   *  onNew. Right-clicking the strip's blank area opens the same menu. */
  onNewBrowser?: () => void;
  /** Buttons pinned to the strip's right edge, outside the scrolling tabs. */
  actions?: ReactNode;
  /** Node pinned left of the tabs (e.g. a sidebar expand button). */
  leading?: ReactNode;
  /** Reserve the macOS traffic-light inset; turn off while the full-height
   *  sidebar owns the titlebar's left edge. Default true. */
  trafficLightInset?: boolean;
}

/**
 * Conversation tab strip doubling as the window drag region (overlay
 * titlebar). data-tauri-drag-region="deep" lets Tauri drag the window —
 * and toggle maximize on double-click — from any non-interactive spot in
 * the strip (its own padding, the scroll container's blank tail); tabs and
 * buttons stay clickable. Tabs scroll horizontally without a scrollbar and
 * vertical wheel deltas translate to horizontal scroll, like VSCode.
 */
export function SessionTabStrip({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onCloseAll,
  onCloseInactive,
  closeLabel,
  onReorder,
  actions,
  onNew,
  onNewBrowser,
  leading,
  trafficLightInset = true,
}: SessionTabStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  // 页签向下拖出页签条 = 拖到对话区分屏（横向仍是排序）。没有分屏 provider 时
  // （独立渲染/测试）保持原行为。
  const splitDrag = useOptionalSplitDrag();
  const handleDragOut = useCallback(
    (tab: SessionTabItem, event: PointerEvent) => {
      if (!splitDrag || !tab.session) return false;
      // 交接发生在 pointermove 上：那里 `button` 是 -1（“没有按键变化”），
      // 按拖拽起点重建一个显式的左键事件，拖拽层才认。
      splitDrag.startDrag(
        { kind: "session", session: tab.session, label: tab.label },
        {
          button: 0,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerType: event.pointerType,
        },
      );
      return true;
    },
    [splitDrag],
  );
  const { dropTarget, suppressClickRef, handleTabPointerDown } = useTabDragReorder(
    onReorder,
    splitDrag ? handleDragOut : undefined,
  );
  const titlebarStyle = useTitlebarStyle();
  // 左侧红绿灯区：macOS 系统原生红绿灯 或 Windows 仿 mac 自绘按钮。
  const customControls = needsWindowControls(titlebarStyle);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // "+" button right-click menu (新建会话 / 新建浏览器), separate anchor
  // state from the tab menu.
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const { handleTabListKeyDown } = useTabStripChrome({
    scrollRef,
    activeKey,
    tabCount: tabs.length,
  });

  return (
    <div
      data-tauri-drag-region="deep"
      data-tab-strip=""
      className={cx(
        "flex h-10 shrink-0 items-center border-b border-separator-border bg-background-primary-default select-none",
        (IS_MAC || customControls) && trafficLightInset && "pl-[80px]",
      )}
    >
      {customControls && trafficLightInset && (
        <div className="flex h-full shrink-0 items-center pl-3 pr-4">
          <WindowControls />
        </div>
      )}
      {leading && <div className="flex h-full shrink-0 items-center pl-2">{leading}</div>}
      <div
        ref={scrollRef}
        onKeyDown={handleTabListKeyDown}
        onContextMenu={
          onNew && onNewBrowser
            ? (e) => {
                // 空白区域右键：与“+”按钮同一菜单。落在标签或“+”上的
                // contextmenu 由各自处理器接管（且标签菜单会
                // preventDefault），这里只认直接命中容器本身的事件。
                if (e.defaultPrevented || e.target !== e.currentTarget) return;
                e.preventDefault();
                setNewMenu({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
        className="group scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto px-2"
      >
      <div role="tablist" aria-label="tabs" className="flex min-w-0 items-center gap-1">
      {tabs.map((tab) => (
        <SessionTab
          key={tab.key}
          tab={tab}
          isActive={tab.key === activeKey}
          dragged={dropTarget?.draggedKey === tab.key}
          dropBefore={dropTarget?.key === tab.key ? dropTarget.before : null}
          closeLabel={closeLabel}
          onShowMenu={onCloseAll || onCloseInactive ? setMenu : undefined}
          onSelect={onSelect}
          onClose={onClose}
          onPointerDown={onReorder ? handleTabPointerDown(tab) : undefined}
          suppressClickRef={suppressClickRef}
        />
      ))}
      </div>
      {onNew && (
        <button
          type="button"
          aria-label={t("chat.newChat")}
          title={t("chat.newChat")}
          onClick={onNew}
          onContextMenu={
            onNewBrowser
              ? (e) => {
                  e.preventDefault();
                  setNewMenu({ x: e.clientX, y: e.clientY });
                }
              : undefined
          }
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-tertiary opacity-0 transition-opacity hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      )}
      </div>
      {actions && (
        <div className="flex h-full shrink-0 items-center">
          {actions}
        </div>
      )}
      <TabStripContextMenu
        menu={menu}
        onCloseAll={onCloseAll}
        onCloseInactive={onCloseInactive}
        onDismiss={() => setMenu(null)}
      />
      {newMenu && onNewBrowser && onNew && (
        <ContextMenu
          x={newMenu.x}
          y={newMenu.y}
          ariaLabel={t("chat.newChat")}
          entries={[
            {
              id: "new-session",
              label: t("chat.newSession"),
              icon: <MessageSquarePlus className="size-4" aria-hidden />,
              onSelect: onNew,
            },
            {
              id: "new-browser",
              label: t("chat.newBrowser"),
              icon: <Globe className="size-4" aria-hidden />,
              onSelect: onNewBrowser,
            },
          ]}
          onClose={() => setNewMenu(null)}
        />
      )}
    </div>
  );
}
