import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import Rows2 from "lucide-react/dist/esm/icons/rows-2";
import X from "lucide-react/dist/esm/icons/x";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { EmptyState } from "@/components/base/empty-state";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import type { EngineInfo, Workspace } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { ChatConversation } from "../components/ChatConversation";
import { focusComposerWhenVisible } from "../focus-composer";
import { useChatStore } from "../store";
import { sessionKey, type ActiveSession } from "../store/persistence";
import { PANEL_TOGGLE_CLASSES } from "../panel-toggle-classes";
import { McpCommandPanel } from "@/features/mcp/McpCommandPanel";
import { composerBridgeRef, registerPaneComposerRef } from "./composer-bridge";
import { useDragSource, useOptionalSplitDrag } from "./drag";
import { installSplitSync, useSplitStore } from "./store";
import {
  layoutGeometry,
  MAX_RATIO,
  MIN_RATIO,
  SOLO_PANE_ID,
  type DividerRect,
  type PaneNode,
  type Rect,
} from "./tree";

/**
 * 中心区分屏布局（Trellis 式）：
 * - `root === null` 时就是原来的单栏对话（不渲染格子标题栏，视觉不变）；
 * - 一旦分屏，每个格子绝对定位渲染，增删格子只改坐标不动组件层级——
 *   已挂载的对话不会被卸载，滚动位置和输入状态都留住；
 * - 格子标题栏可拖动重排（拖到别的格子边上=整格搬家，拖到中心=两边互换）。
 */

/** 拖动分隔条时两侧各自保留的最小像素（小于它就把比例夹回去）。 */
const MIN_PANE_PX = 220;
const MIN_PANE_PX_COLUMN = 140;
const KEYBOARD_RATIO_STEP = 0.02;

function rectStyle(rect: Rect) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

function ratioBounds(sizePx: number, minPanePx: number): [number, number] {
  if (!(sizePx > 0)) return [MIN_RATIO, MAX_RATIO];
  const min = minPanePx / sizePx;
  // 分支本身比两倍最小格子还小：退回全局比例下限，别再互相挤压。
  if (min * 2 >= 1) return [MIN_RATIO, MAX_RATIO];
  return [Math.max(MIN_RATIO, min), Math.min(MAX_RATIO, 1 - min)];
}

function clampTo(ratio: number, [lo, hi]: [number, number]): number {
  if (!Number.isFinite(ratio)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, ratio));
}

export function SplitLayout({
  active,
  engines,
  workspaces,
  startNewChat,
}: {
  active: ActiveSession | null;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
}) {
  // 分屏布局与聊天 store 的同步订阅（幂等，卸载不解除：布局活在 store 里）。
  useEffect(() => installSplitSync(), []);
  const root = useSplitStore((s) => s.root);
  const focusedPaneId = useSplitStore((s) => s.focusedPaneId);
  const resizing = useOptionalSplitDrag()?.resizing ?? false;
  // 单栏模式的输入框句柄：登记到 SOLO_PANE_ID 上，供全局 ref 桥解析。
  const soloComposerRef = useRef<ComposerInputHandle | null>(null);
  useEffect(() => registerPaneComposerRef(SOLO_PANE_ID, soloComposerRef), []);
  const geometry = useMemo(() => (root ? layoutGeometry(root) : null), [root]);
  const fallbackWorkspacePath = active?.workspacePath ?? workspaces[0]?.path ?? "";

  const body =
    !root || !geometry ? (
      <div
        data-split-pane={SOLO_PANE_ID}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background-primary-default"
      >
        <ChatConversation
          active={active}
          engines={engines}
          workspaces={workspaces}
          startNewChat={startNewChat}
          composerInputRef={soloComposerRef}
        />
      </div>
    ) : (
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {geometry.panes.map(({ pane, rect }) => (
          <SplitPaneView
            key={pane.id}
            pane={pane}
            rect={rect}
            focused={pane.id === focusedPaneId}
            animate={!resizing}
            engines={engines}
            workspaces={workspaces}
            startNewChat={startNewChat}
            fallbackWorkspacePath={fallbackWorkspacePath}
          />
        ))}
        {geometry.dividers.map((divider) => (
          <SplitDivider key={divider.branchId} divider={divider} />
        ))}
      </div>
    );

  return (
    <>
      {body}
      {/* `/mcp` 面板是全局单例（读全局 active 的引擎）：放在分屏层渲染一次，
          否则每个格子的对话都会挂一份，打开时叠成多层。 */}
      <McpCommandPanel />
    </>
  );
}

const SplitPaneView = memo(function SplitPaneView({
  pane,
  rect,
  focused,
  animate,
  engines,
  workspaces,
  startNewChat,
  fallbackWorkspacePath,
}: {
  pane: PaneNode;
  rect: Rect;
  focused: boolean;
  animate: boolean;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
  fallbackWorkspacePath: string;
}) {
  const { t } = useTranslation();
  const session = pane.session;
  const key = session
    ? sessionKey(session.engine, session.sessionId, session.workspacePath)
    : "";
  const sessions = useChatStore((s) => s.sessions);
  const streaming = useChatStore((s) => (key ? s.streamingByKey[key] === true : false));
  const splitPane = useSplitStore((s) => s.splitPane);
  const closePane = useSplitStore((s) => s.closePane);
  const focusPane = useSplitStore((s) => s.focusPane);
  const composerRef = useRef<ComposerInputHandle | null>(null);
  useEffect(() => registerPaneComposerRef(pane.id, composerRef), [pane.id]);
  const title = useMemo(() => {
    if (!session) return "";
    if (!session.sessionId) return t("chat.newChat");
    const meta = sessions.find(
      (item) => item.engine === session.engine && item.sessionId === session.sessionId,
    );
    return meta?.customTitle || meta?.title || session.sessionId.slice(0, 8);
  }, [session, sessions, t]);
  const dragPayload = useMemo(
    () => ({ kind: "pane" as const, paneId: pane.id, label: title }),
    [pane.id, title],
  );
  const startDrag = useDragSource(dragPayload);
  // 点格子任意处 = 聚焦这一格（标题栏上的按钮除外，它们各自有动作）。
  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent) => {
      if ((event.target as HTMLElement).closest("[data-pane-action]")) return;
      focusPane(pane.id);
    },
    [focusPane, pane.id],
  );
  const handleHeaderPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // 标题栏上的按钮只走点击，别把关闭/分屏手势变成拖动。
      if ((event.target as HTMLElement).closest("button")) return;
      startDrag(event);
    },
    [startDrag],
  );

  return (
    <div
      data-split-pane={pane.id}
      onPointerDownCapture={handlePointerDownCapture}
      style={rectStyle(rect)}
      className={cx(
        "absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-background-primary-default",
        animate && "transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none",
      )}
    >
      <div
        onPointerDown={handleHeaderPointerDown}
        className={cx(
          "group/pane flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b pr-1 pl-2 select-none",
          focused ? "border-border-focus-ring" : "border-separator-border",
        )}
      >
        {session ? (
          <EngineIcon
            engine={session.engine}
            size={12}
            className="size-3 shrink-0 text-foreground-icon-secondary"
          />
        ) : null}
        <span
          className="min-w-0 flex-1 truncate text-caption-1-medium text-text-secondary"
          title={title || undefined}
        >
          {title || t("chat.emptyPaneNewChat")}
        </span>
        {streaming ? (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent-500"
            aria-hidden
          />
        ) : null}
        <span
          data-pane-action=""
          className={cx(
            "flex shrink-0 items-center gap-0.5 transition-opacity",
            focused ? "opacity-100" : "opacity-0 group-hover/pane:opacity-100",
          )}
        >
          <button
            type="button"
            title={t("chat.splitRight")}
            aria-label={t("chat.splitRight")}
            onClick={() => splitPane(pane.id, "row")}
            className={PANEL_TOGGLE_CLASSES}
          >
            <Columns2 className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            title={t("chat.splitDown")}
            aria-label={t("chat.splitDown")}
            onClick={() => splitPane(pane.id, "col")}
            className={PANEL_TOGGLE_CLASSES}
          >
            <Rows2 className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            title={t("chat.closePane")}
            aria-label={t("chat.closePane")}
            onClick={() => closePane(pane.id)}
            className={PANEL_TOGGLE_CLASSES}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {session ? (
          <ChatConversation
            active={session}
            engines={engines}
            workspaces={workspaces}
            startNewChat={startNewChat}
            composerInputRef={composerRef}
          />
        ) : (
          <EmptyPane
            paneId={pane.id}
            workspacePath={fallbackWorkspacePath}
            startNewChat={startNewChat}
          />
        )}
      </div>
    </div>
  );
});

/** 空格子：等待拖入会话，或就地开一个新会话（新会话落在这一格里）。 */
function EmptyPane({
  paneId,
  workspacePath,
  startNewChat,
}: {
  paneId: string;
  workspacePath: string;
  startNewChat: (workspacePath: string) => void;
}) {
  const { t } = useTranslation();
  const focusPane = useSplitStore((s) => s.focusPane);
  return (
    <EmptyState className="flex-col gap-2 px-6 text-center text-body-medium">
      <span>{t("chat.emptyPaneHint")}</span>
      <button
        type="button"
        disabled={!workspacePath}
        onClick={() => {
          // 先聚焦这一格：新会话（pending 页签）会落进当前聚焦格；输入框
          // 挂载后把焦点给它（隐藏面里 focus() 会被忽略，交给重试助手）。
          focusPane(paneId);
          startNewChat(workspacePath);
          focusComposerWhenVisible(composerBridgeRef);
        }}
        className="cursor-pointer rounded-md border border-border-secondary bg-background-secondary-default px-2.5 py-1 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-tertiary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t("chat.emptyPaneNewChat")}
      </button>
    </EmptyState>
  );
}

function SplitDivider({ divider }: { divider: DividerRect }) {
  const { t } = useTranslation();
  const setRatio = useSplitStore((s) => s.setRatio);
  const drag = useOptionalSplitDrag();
  const isRow = divider.direction === "row";

  const containerBox = (element: HTMLElement) =>
    element.parentElement?.getBoundingClientRect() ?? null;

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const box = containerBox(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      event.stopPropagation();
      drag?.setResizing(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = isRow ? "col-resize" : "row-resize";
      const branch = divider.branchRect;
      const onMove = (moveEvent: PointerEvent) => {
        if (divider.direction === "row") {
          const left = box.left + branch.x * box.width;
          const size = branch.w * box.width;
          const bounds = ratioBounds(size, MIN_PANE_PX);
          setRatio(divider.branchId, clampTo((moveEvent.clientX - left) / size, bounds));
          return;
        }
        const top = box.top + branch.y * box.height;
        const size = branch.h * box.height;
        const bounds = ratioBounds(size, MIN_PANE_PX_COLUMN);
        setRatio(divider.branchId, clampTo((moveEvent.clientY - top) / size, bounds));
      };
      const onUp = () => {
        drag?.setResizing(false);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [divider, drag, isRow, setRatio],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const forward = isRow ? "ArrowRight" : "ArrowDown";
      const backward = isRow ? "ArrowLeft" : "ArrowUp";
      if (event.key !== forward && event.key !== backward) return;
      event.preventDefault();
      const box = containerBox(event.currentTarget);
      if (!box) return;
      const size = isRow
        ? divider.branchRect.w * box.width
        : divider.branchRect.h * box.height;
      const bounds = ratioBounds(size, isRow ? MIN_PANE_PX : MIN_PANE_PX_COLUMN);
      const delta = event.key === forward ? KEYBOARD_RATIO_STEP : -KEYBOARD_RATIO_STEP;
      setRatio(divider.branchId, clampTo(divider.ratio + delta, bounds));
    },
    [divider, isRow, setRatio],
  );

  return (
    <div
      role="separator"
      data-split-divider=""
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label={t("chat.resizePane")}
      aria-valuenow={Math.round(divider.ratio * 100)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={cx(
        "group/divider absolute z-10 touch-none outline-none",
        isRow ? "cursor-col-resize -translate-x-1/2" : "cursor-row-resize -translate-y-1/2",
      )}
      style={
        isRow
          ? {
              left: `${divider.rect.x * 100}%`,
              top: `${divider.rect.y * 100}%`,
              height: `${divider.rect.h * 100}%`,
              width: 9,
            }
          : {
              left: `${divider.rect.x * 100}%`,
              top: `${divider.rect.y * 100}%`,
              width: `${divider.rect.w * 100}%`,
              height: 9,
            }
      }
    >
      <span
        className={cx(
          "absolute bg-separator-border transition-colors duration-150 group-hover/divider:bg-border-focus-ring group-focus-visible/divider:bg-border-focus-ring",
          isRow ? "top-0 bottom-0 left-1/2 w-px -translate-x-1/2" : "left-0 right-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
