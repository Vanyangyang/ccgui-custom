"use client";

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import FolderCode from "lucide-react/dist/esm/icons/folder-code";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Menu from "lucide-react/dist/esm/icons/menu";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Pin from "lucide-react/dist/esm/icons/pin";
import Plus from "lucide-react/dist/esm/icons/plus";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { paginateThreads } from "@/components/application/ai-chat/repo-pagination";
import { ipc } from "@/lib/ipc";
import { useWorktreeStore } from "@/features/worktree/store";
import { WorktreeProgressRow } from "@/features/worktree/WorktreeProgressRow";
import type { AiChatRepo, AiChatThread, ThreadAction } from "@/components/application/ai-chat/sidebar-types";
import { useDragSource } from "@/features/chat/split/drag";
import { sessionFromThreadId } from "@/features/chat/split/store";
import { cx } from "@/utils/cx";
import { threadContains, flattenLeaderThreads } from "@/features/leader/tree";
import { useLeaderTreeUI } from "@/features/leader/tree-ui";
import { threadTreeWorkspaceKey, type RecentThread } from "./recent-threads";
import { leaderDeadlineInfo } from "@/features/leader/branch-health";
import { Focusable } from "react-aria-components";
import { Tooltip, TooltipContent } from "@/components/base/tooltip/tooltip";
import {
  cacheHeatChipStyle,
  cacheHeatRingStroke,
  cacheHeatTextColor,
} from "@/features/chat/session-cleanup";
import { usePromptCacheHeat } from "@/features/chat/use-prompt-cache";
import { CrossSessionThreadIndicator, useCrossSessionThreadActivity } from "@/features/chat/components/CrossSessionCommsPanel";
import Hourglass from "lucide-react/dist/esm/icons/hourglass";
import { cacheWindowSummary, cacheWindowText, getPromptCacheHeatRatio, getSessionCacheHeat, isPromptCacheExpiringSoon, promptCacheForEngine, type CacheHeat } from "@/features/chat/prompt-cache";
import type { PromptCacheWindow } from "@/lib/ipc";

/** Streaming/unseen status dot on a thread row; renders nothing when the
 *  thread is neither streaming nor waiting to be seen. */
function ThreadStatusDot({
  streaming,
  retrying,
  unseen,
}: {
  streaming: boolean;
  retrying: boolean;
  unseen: boolean;
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
  return null;
}

/** Row-hover actions (pin / rename / delete). Drafts only offer delete. */
function ThreadHoverActions({
  id,
  pinned,
  isDraft,
  protectedFromDeletion,
  onAction,
}: {
  id: string;
  pinned: boolean;
  isDraft: boolean;
  protectedFromDeletion?: boolean;
  onAction?: (id: string, action: ThreadAction) => void;
}) {
  const { t } = useTranslation();
  if (!onAction) return null;
  const iconClass = "text-foreground-icon-secondary hover:text-foreground-icon-primary";
  return (
    <span className="hidden shrink-0 items-center gap-1.5 group-hover:inline-flex">
      {!isDraft && (
        <button
          type="button"
          aria-label={pinned ? t("chat.unpin") : t("chat.pin")}
          onClick={(event) => {
            event.stopPropagation();
            onAction(id, "pin");
          }}
          className={iconClass}
        >
          <Pin className="size-3.5" aria-hidden />
        </button>
      )}
      {!isDraft && (
        <button
          type="button"
          aria-label={t("chat.renameSession")}
          onClick={(event) => {
            event.stopPropagation();
            onAction(id, "rename");
          }}
          className={iconClass}
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
      )}
      {!protectedFromDeletion && <button
        type="button"
        aria-label={t("chat.deleteSession")}
        onClick={(event) => {
          event.stopPropagation();
          onAction(id, "delete");
        }}
        className={iconClass}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </button>}
    </span>
  );
}

/** Chat row under an open repo — indented 36px, relative-time chip on the
 *  right, hover action icons (pin / rename / delete; archive lives in the
 *  right-click menu only). */
/** Hover card & badge for prompt-cache retention: replaces the native OS
 *  title box with a compact, gradient-synced card (status pill, countdown,
 *  progress bar, and local expiry window). */
export function CacheHeatHoverBadge({
  engine,
  time,
  cache,
  cacheHeat,
  heatRatio,
  updatedAt,
  streaming = false,
  hideOnGroupHover = false,
}: {
  engine?: string;
  time: string;
  cache?: PromptCacheWindow | null;
  cacheHeat: CacheHeat;
  heatRatio: number;
  updatedAt?: number | null;
  streaming?: boolean;
  hideOnGroupHover?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (engine === "cursor") {
    return (
      <span
        style={cacheHeatChipStyle(0)}
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-caption-2-medium whitespace-nowrap text-text-tertiary transition-colors duration-300",
          hideOnGroupHover && "group-hover:hidden",
        )}
      >
        {time}
      </span>
    );
  }

  const liveHeat = open ? getSessionCacheHeat(cache, now) : cacheHeat;
  const liveRatio = open ? getPromptCacheHeatRatio(cache, updatedAt, streaming, now) : heatRatio;
  const badgeExpiringSoon = isPromptCacheExpiringSoon(heatRatio);
  const summary = cacheWindowSummary(t, cache, liveHeat, now);
  const cardExpiringSoon = summary.expiringSoon;
  const fullText = cacheWindowText(t, cache, liveHeat);
  const pct = Math.round(Math.max(0, Math.min(1, liveRatio)) * 100);
  const accentColor = cardExpiringSoon ? "var(--color-text-warning-primary)" : cacheHeatTextColor(liveRatio);
  const barColor = cardExpiringSoon ? "var(--color-text-warning-primary)" : cacheHeatRingStroke(liveRatio);
  const chipStyle = cardExpiringSoon
    ? {
        color: "var(--color-text-warning-primary)",
        backgroundColor: "var(--color-background-tertiary-warning)",
      }
    : cacheHeatChipStyle(liveRatio);
  const triggerStyle = badgeExpiringSoon
    ? {
        color: "var(--color-text-warning-primary)",
        backgroundColor: "var(--color-background-tertiary-warning)",
      }
    : cacheHeatChipStyle(heatRatio);

  return (
    <Tooltip isOpen={open} onOpenChange={setOpen} delay={120} closeDelay={0}>
      <Focusable>
        <span
          role="button"
          tabIndex={0}
          data-cache-heat={cacheHeat}
          data-cache-heat-ratio={heatRatio}
          data-cache-expiring-soon={badgeExpiringSoon ? "true" : undefined}
          aria-label={fullText}
          title={open ? undefined : fullText}
          style={triggerStyle}
          className={cx(
            "inline-flex shrink-0 items-center justify-center gap-0.5 rounded-sm px-1 py-px text-caption-2-medium whitespace-nowrap outline-none transition-colors duration-300 focus-visible:ring-1 focus-visible:ring-border-focus-ring",
            badgeExpiringSoon || heatRatio >= 0.35
              ? "bg-background-tertiary-warning text-text-warning-primary"
              : "bg-background-tertiary-default text-text-tertiary",
          )}
        >
          {badgeExpiringSoon && (
            <Hourglass
              data-testid="cache-expiring-hourglass"
              className="size-2.5 shrink-0 animate-pulse motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {time}
        </span>
      </Focusable>
      <TooltipContent
        placement="right"
        offset={8}
        className="w-[268px] max-w-[calc(100vw-32px)] rounded-xl border border-border-button-default bg-background-primary-default p-2.5 shadow-lg"
      >
        <div data-testid="cache-window-hover-card" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span
              style={chipStyle}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption-2-medium"
            >
              {cardExpiringSoon ? (
                <Hourglass
                  data-testid="cache-card-expiring-hourglass"
                  style={{ color: barColor }}
                  className="size-3 shrink-0 animate-pulse motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <span
                  style={{ backgroundColor: barColor }}
                  className="size-1.5 shrink-0 rounded-full"
                  aria-hidden
                />
              )}
              {summary.statusLabel}
            </span>
            <span
              style={{ color: accentColor }}
              className="text-caption-1-medium whitespace-nowrap tabular-nums"
            >
              {summary.headline}
            </span>
          </div>

          {cache && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-background-tertiary-default">
              <div
                data-testid="cache-window-progress-bar"
                style={{
                  width: `${pct}%`,
                  backgroundColor: barColor,
                }}
                className="h-full rounded-full transition-[width,background-color] duration-300"
              />
            </div>
          )}

          {summary.expiryRange && (
            <div className="flex flex-col gap-0.5 rounded-lg bg-background-secondary-default px-2 py-1 text-caption-2-medium">
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-tertiary">
                  {t(summary.isReference ? "chat.cacheCardReferenceExpiryLabel" : "chat.cacheCardExpiryLabel")}
                </span>
                {summary.expirySpanLabel && (
                  <span className="text-text-tertiary">
                    {summary.expirySpanLabel}
                  </span>
                )}
              </div>
              <span
                style={{ color: liveRatio > 0 ? accentColor : undefined }}
                className="font-mono whitespace-nowrap text-text-secondary tabular-nums"
              >
                {summary.expiryRange}
              </span>
            </div>
          )}

          <p className="text-caption-2-medium leading-relaxed text-text-tertiary">
            {summary.note}
            {summary.mixedNote ? ` ${summary.mixedNote}` : ""}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadItem({
  id,
  label,
  engine,
  time,
  updatedAt,
  promptCache,
  workspaceLabel,
  workspacePath,
  pinned = false,
  isSelected = false,
  streaming = false,
  retrying = false,
  unseen = false,
  isDraft = false,
  protectedFromDeletion,
  selectable = true,
  leaderBranch,
  disclosure,
  tabIndex,
  onSelect,
  onAction,
  onContextMenu,
  flat = false,
}: AiChatThread & {
  tabIndex?: number;
  onSelect?: (id: string) => void;
  onAction?: (id: string, action: ThreadAction) => void;
  /** Right-click anywhere on the row: opens the thread context menu. */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
  disclosure?: ReactNode;
  /** 【全部会话】不缩进到工作区树下。 */
  flat?: boolean;
}) {
  const { t } = useTranslation();
  const branchDeadline = leaderBranch ? leaderDeadlineInfo(leaderBranch) : null;
  const comms = useCrossSessionThreadActivity(isDraft ? undefined : id, workspacePath ?? leaderBranch?.workspacePath);
  const enabledCache = promptCacheForEngine(engine, promptCache);
  const cacheHeat = usePromptCacheHeat(enabledCache);
  const heatRatio = getPromptCacheHeatRatio(enabledCache, updatedAt, streaming);
  const branchStatus = leaderBranch ? t(`leader.state.${leaderBranch.state}`) : "";
  const branchTTL = leaderBranch && branchDeadline
    ? branchDeadline.known ? t(branchDeadline.expired ? "leader.ttlExpiredShort" : "leader.ttlShort", { time: new Date(leaderBranch.deadlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : t("leader.ttlUnknownShort")
    : "";
  const branchTooltip = leaderBranch && branchDeadline ? [branchStatus,
    branchDeadline.known ? t(branchDeadline.expired ? "leader.expiredDeadline" : "leader.deadline", { time: new Date(leaderBranch.deadlineAt).toLocaleString() }) : t("leader.deadlineUnknown"),
    leaderBranch.error].filter(Boolean).join("\n") : "";
  // 拖到中心区 = 分屏（边=切分到那一侧，中心=替换/互换）：会话在按下时才查，
  // 免得每一行都订阅整个会话列表。
  const startDrag = useDragSource(
    useCallback(() => {
      const session = sessionFromThreadId(id);
      return session ? { kind: "session" as const, session, label } : null;
    }, [id, label]),
  );
  return (
    <div
      data-comm-active={comms.active || undefined}
      data-comm-related={comms.related || undefined}
      onContextMenu={
        id && onContextMenu ? (event) => onContextMenu(event, id) : undefined
      }
      className={cx(
        "group flex w-full cursor-pointer items-center gap-1.5 rounded-2lg py-[5px] pr-2 transition-colors duration-150 ease motion-reduce:transition-none",
        flat ? "pl-2" : "pl-9",
        isSelected ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
        comms.active && "bg-status-purple-background/50",
        comms.related && "ring-1 ring-inset ring-status-purple-text",
      )}
    >
      {disclosure}
      {/* The row body is the button; hover actions sit beside it so no
          control nests inside another. */}
      <button
        type="button"
        tabIndex={tabIndex}
        data-thread-select=""
        title={comms.active ? [label, workspaceLabel, time].filter(Boolean).join(" · ") : undefined}
        aria-current={isSelected ? "page" : undefined}
        disabled={!selectable}
        onPointerDown={selectable ? startDrag : undefined}
        onClick={() => id && onSelect?.(id)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        {engine && (
          <EngineIcon
            engine={engine}
            size={12}
            className="size-3 shrink-0 text-foreground-icon-secondary"
          />
        )}
        <ThreadStatusDot streaming={streaming} retrying={retrying} unseen={unseen} />
        {/* Native title tooltip: hover a moment to read the full title when
            the row truncates it (same pattern as the repo row below). */}
        <span
          className={cx("min-w-0 flex-1 truncate text-body-2-medium", isSelected ? "text-text-primary" : "text-text-secondary")}
          title={label}
        >
          {pinned && (
            <Pin
              fill="currentColor"
              className="mr-1 inline size-3 text-foreground-icon-secondary"
              aria-hidden
            />
          )}
          {(() => {
            const match = /^(.+?)\s*[｜|]\s*(.+)$/.exec(label);
            const topic = match?.[1]?.trim();
            const detail = match?.[2]?.trim();
            if (!topic || !detail) return label;
            return (
              <>
                <span className="font-medium text-text-primary">{topic}</span>
                <span aria-hidden className="mx-1.5 text-text-quaternary">·</span>
                <span className={cx("font-normal", isSelected ? "text-text-secondary" : "text-text-tertiary")}>{detail}</span>
              </>
            );
          })()}
        </span>
        {comms.summary && <span data-testid="thread-cross-session-summary" title={comms.summary}
          className="max-w-[48%] shrink truncate text-caption-2-medium text-status-purple-text">{comms.summary}</span>}
      </button>
      {id && selectable && (
        <ThreadHoverActions id={id} pinned={pinned} isDraft={isDraft} protectedFromDeletion={protectedFromDeletion} onAction={onAction} />
      )}
      {leaderBranch && <span className="inline-flex max-w-28 shrink-0 items-center gap-1 rounded-sm bg-background-tertiary-default px-1 py-px text-caption-2-medium text-text-tertiary group-hover:hidden" title={branchTooltip}>
        <span className="max-w-full truncate">{branchStatus}</span>
        {!["completed", "failed", "stopped"].includes(leaderBranch.state) && branchTTL && <span className="whitespace-nowrap">{branchTTL}</span>}
      </span>}
      {workspaceLabel && !comms.active ? (
        <span
          title={workspaceLabel}
          className="max-w-28 shrink-0 truncate rounded-sm bg-background-tertiary-default/60 px-1.5 py-px text-caption-2-regular text-text-tertiary group-hover:hidden"
        >
          {workspaceLabel}
        </span>
      ) : null}
      {time && !leaderBranch && !comms.active ? (
        <CacheHeatHoverBadge
          engine={engine}
          time={time}
          cache={enabledCache}
          cacheHeat={cacheHeat}
          heatRatio={heatRatio}
          updatedAt={updatedAt}
          streaming={streaming}
          hideOnGroupHover={engine === "cursor"}
        />
      ) : null}
      {/* Keep this at the row edge: hover swaps metadata for action buttons,
          so a marker placed before them would move away from the pointer. */}
      {id && !isDraft && <CrossSessionThreadIndicator threadId={id} workspacePath={workspacePath ?? leaderBranch?.workspacePath} />}
    </div>
  );
}

/**
 * Curved tree connector (Figma "Vector 132"): a vertical guide dropping from
 * the repo's folder icon with a rounded elbow into each thread row.
 */
function TreeConnector({ count }: { count: number }) {
  // Rows are 28px tall (py-[5px] + 18px line-height) with a 2px gap,
  // and the container's pt-0.5 pushes the first row down 2px.
  const rowPitch = 30; // 28px row + 2px gap
  const firstCenter = 16; // 2px container padding + half of the 28px row
  const height = firstCenter + rowPitch * (count - 1) + 1;
  return (
    <svg
      aria-hidden
      width="12"
      height={height}
      viewBox={`0 0 12 ${height}`}
      fill="none"
      className="pointer-events-none absolute top-0 left-[16.5px] text-foreground-icon-quaternary"
    >
      {Array.from({ length: count }, (_, i) => {
        const y = firstCenter + rowPitch * i;
        return (
          <path
            key={y}
            d={`M0.5 0 V${y - 5} Q0.5 ${y} 5.5 ${y} H11.5`}
            stroke="currentColor"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}

/** Immediate drag entry attached to a repo row's grip handle. */
interface DragHandleProps {
  onPointerDown: (event: ReactPointerEvent) => void;
}

/** The repo row itself: merged folder/reorder-grip button, label, hover
 *  actions (new session / remove) and the thread count chip. Right-click
 *  bubbles to the workspace context menu via `onContextMenu`. */
function RepoHeaderRow({
  repo,
  expanded,
  isDragging,
  dragHandleProps,
  hasHoverActions,
  dragDownPos,
  onToggleOpen,
  onNewSession,
  onRemove,
  onContextMenu,
}: {
  repo: AiChatRepo;
  expanded: boolean;
  isDragging: boolean;
  dragHandleProps: DragHandleProps | null;
  hasHoverActions: boolean;
  /** Pointer-down position on the merged folder/grip button: a press that
   *  travels past the threshold is a reorder drag, so its trailing click must
   *  not toggle the row. */
  dragDownPos: { current: { x: number; y: number } | null };
  onToggleOpen: () => void;
  onNewSession?: (id: string) => void;
  onRemove?: (id: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const Icon = repo.isSelfDev ? FolderCode : expanded ? FolderOpen : FolderSymlink;
  const collapseLabel = expanded ? t("chat.collapseWorkspace") : t("chat.expandWorkspace");
  return (
    <div
      onContextMenu={onContextMenu}
      data-self-dev-workspace={repo.isSelfDev ? "true" : undefined}
      className={cx(
        "group flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover",
        repo.isSelfDev && "bg-status-purple-background/20 hover:bg-status-purple-background/35",
      )}
    >
      <button
        type="button"
        aria-label={collapseLabel}
        title={dragHandleProps ? t("chat.dragToReorder") : collapseLabel}
        onPointerDown={(event) => {
          if (!dragHandleProps) return;
          event.stopPropagation();
          dragDownPos.current = { x: event.clientX, y: event.clientY };
          dragHandleProps.onPointerDown(event);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (dragDownPos.current) {
            const dx = Math.abs(event.clientX - dragDownPos.current.x);
            const dy = Math.abs(event.clientY - dragDownPos.current.y);
            dragDownPos.current = null;
            if (dx + dy > 4) return;
          }
          onToggleOpen();
        }}
        className={cx(
          "relative -m-0.5 size-6 shrink-0 cursor-pointer rounded-md transition-colors duration-150 hover:bg-background-tertiary-hover/55",
          dragHandleProps && "group-hover:cursor-grab",
          isDragging && "cursor-grabbing",
        )}
      >
        {/* One slot, two affordances: folder by default; on row hover it
            fades out and the reorder grip fades in (when reorder is
            enabled). Plain click toggles collapse; press-and-move drags. */}
        <span
          className={cx(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-150",
            dragHandleProps && "group-hover:opacity-0",
          )}
          aria-hidden
        >
          <Icon
            className={cx(
              "size-4",
              repo.isSelfDev ? "text-status-purple-text" : "text-foreground-icon-secondary",
            )}
          />
        </span>
        {dragHandleProps && (
          <span
            className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            aria-hidden
          >
            <Menu className="size-4 text-foreground-icon-secondary group-hover:text-foreground-icon-primary" />
          </span>
        )}
      </button>
      {/* Row body toggles as its own button, keeping the folder/drag handle
          and hover actions as sibling controls instead of nested ones. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center text-left"
      >
        <span
          title={repo.originalLabel}
          className={cx(
            "truncate text-body-2-medium whitespace-nowrap",
            repo.isSelfDev ? "text-text-primary" : "text-text-secondary",
          )}
        >
          {repo.label}
        </span>
        {repo.isSelfDev && (
          <span
            data-testid="self-dev-workspace-badge"
            title={t("chat.selfDevWorkspaceHint")}
            className="ml-1.5 inline-flex shrink-0 items-center rounded-sm bg-status-purple-background px-1.5 py-px text-caption-2-medium text-status-purple-text"
          >
            {t("chat.selfDevWorkspaceBadge")}
          </span>
        )}
        {repo.labelSuffix && (
          <span className="ws-label-badge ml-1.5 shrink-0">
            {repo.labelSuffix}
          </span>
        )}
      </button>
      {hasHoverActions && (
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 group-hover:inline-flex">
          {repo.id && onNewSession && (
            <button
              type="button"
              aria-label={t("chat.newSession")}
              title={t("chat.newSession")}
              onClick={(event) => {
                event.stopPropagation();
                onNewSession(repo.id!);
              }}
              className="cursor-pointer text-foreground-icon-secondary hover:text-foreground-icon-primary"
            >
              <Plus className="size-4" aria-hidden />
            </button>
          )}
          {repo.id && onRemove && (
            <button
              type="button"
              aria-label={t("chat.removeWorkspace")}
              title={repo.isSelfDev ? t("chat.removeSelfDevWorkspace") : t("chat.removeWorkspace")}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(repo.id!);
              }}
              className="cursor-pointer text-foreground-icon-secondary hover:text-foreground-icon-primary"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </span>
      )}
      <span
        className={cx(
          "text-caption-2-medium text-text-tertiary",
          hasHoverActions ? "group-hover:hidden" : "ml-auto",
        )}
      >
        {repo.threads.length}
      </span>
    </div>
  );
}

/** A worktree child row: branch icon + branch label + optional PR badge;
 *  click toggles its own thread list, right-click opens the workspace menu
 *  (which renders worktree entries for it). */
function WorktreeChildRow({
  repo,
  expanded,
  active,
  onToggleOpen,
  onNewSession,
  onContextMenu,
}: {
  repo: AiChatRepo;
  expanded: boolean;
  /** This worktree owns the active session. */
  active: boolean;
  onToggleOpen: () => void;
  /** Per-row + button: start a new chat in this worktree workspace. */
  onNewSession?: (workspaceId: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const missing = useWorktreeStore((s) =>
    repo.path ? s.missingPaths[repo.path] === true : false,
  );
  // 收起时把线程运行状态聚合到本行（展开时各线程行自己带状态点）：任一
  // 线程流式中即显示呼吸点；全部流式线程都在退避重试时降为静态点，与会
  // 话行 / 页签同一套 `sidebar-thread-status` 视觉语言。
  const allThreads = flattenLeaderThreads(repo.threads);
  const running = allThreads.some((th) => th.streaming);
  const retrying = running && allThreads.every((th) => !th.streaming || th.retrying);
  return (
    <div
      onContextMenu={onContextMenu}
      className={cx(
        "group flex w-full cursor-pointer items-center gap-1 rounded-2lg py-[5px] pr-2 pl-4 transition-colors duration-150 ease",
        active ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={repo.worktree?.branch}
        title={repo.originalLabel}
        onClick={onToggleOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
      >
        <ChevronRight
          aria-hidden
          className={cx(
            "size-3.5 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
        {!expanded && running && (
          <ThreadStatusDot streaming retrying={retrying} unseen={false} />
        )}
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
          {repo.label}
        </span>
        {repo.worktree?.prNumber != null && (
          <span className="shrink-0 rounded-sm bg-status-purple-background px-1 py-px text-caption-2-medium text-status-purple-text">
            {t("worktree.prBadge", { number: repo.worktree.prNumber })}
          </span>
        )}
        {missing && (
          <span
            className="shrink-0 rounded-sm bg-status-rose-background px-1 py-px text-caption-2-medium text-status-rose-text"
            title={t("worktree.missingDirectoryHint")}
          >
            {t("worktree.missingDirectory")}
          </span>
        )}
      </button>
      {repo.id && onNewSession && (
        <button
          type="button"
          aria-label={t("chat.newSession")}
          title={t("chat.newSession")}
          onClick={(event) => {
            event.stopPropagation();
            onNewSession(repo.id!);
          }}
          className="hidden shrink-0 cursor-pointer items-center text-foreground-icon-secondary group-hover:inline-flex hover:text-foreground-icon-primary"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** 「WORKTREES · n」分组：父工作区展开区内的子工作区列表 + 进行中的创建
 *  进度行。组折叠态与各子行展开态都可持久化（后者复用侧栏的展开集），
 *  两层的展开/收起都走 `SidebarDisclosure` 的高度动画（不再条件渲染直接
 *  闪现）。没有 worktree 也没有进行中创建时不渲染——首个创建入口在右键
 *  菜单。 */
function WorktreeGroup({
  parent,
  activeThreadId,
  isRepoExpanded,
  onToggleRepo,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
  onRepoContextMenu,
  onNewWorktree,
  onNewSession,
}: {
  parent: AiChatRepo;
  activeThreadId?: string;
  isRepoExpanded: (repo: AiChatRepo) => boolean;
  onToggleRepo: (repo: AiChatRepo) => void;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
  onRepoContextMenu?: (event: ReactMouseEvent<HTMLElement>, workspaceId: string) => void;
  onNewWorktree?: (workspaceId: string) => void;
  /** Per-worktree + button: start a new chat in that worktree workspace. */
  onNewSession?: (workspaceId: string) => void;
}) {
  const { t } = useTranslation();
  const children = parent.worktrees ?? [];
  const parentId = parent.id;
  // 选原始数组（引用稳定），filter 放 useMemo：selector 返回新建数组会让
  // zustand 的 getSnapshot 缓存检查报无限循环。
  const allPending = useWorktreeStore((s) => s.pending);
  const pending = useMemo(
    () => allPending.filter((p) => p.parentWorkspaceId === parentId),
    [allPending, parentId],
  );
  const collapsed = useWorktreeStore((s) => (parentId ? s.collapsedGroups[parentId] === true : false));
  const toggleGroupCollapsed = useWorktreeStore((s) => s.toggleGroupCollapsed);

  // 采一次 worktree 列表拿 locked / prunable 状态（右键菜单禁用删除、
  // 子行「目录已丢失」徽标用）。
  const childPathsKey = children.map((c) => c.path ?? "").join("|");
  useEffect(() => {
    if (collapsed) return;
    if (parent.path) {
      void ipc
        .gitWorktreeList(parent.path)
        .then((list) => {
          const locked: Record<string, string> = {};
          const missing: Record<string, true> = {};
          for (const w of list) {
            if (w.locked) locked[w.path] = w.lockReason ?? "";
            if (w.prunable && !w.isMain) missing[w.path] = true;
          }
          useWorktreeStore.getState().setGitStates(locked, missing);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用路径串代替数组引用
  }, [childPathsKey, collapsed, parent.path]);

  if (children.length === 0 && pending.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-0.5 pt-0.5">
      <div className="group flex w-full items-center gap-1 rounded-2lg py-[5px] pr-2 pl-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => parentId && toggleGroupCollapsed(parentId)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cx(
              "size-3 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
              !collapsed && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-caption-1-medium text-text-tertiary">
            {t("worktree.groupLabel", { count: children.length })}
          </span>
        </button>
        {parentId && onNewWorktree && (
          <button
            type="button"
            aria-label={t("worktree.newWorktree")}
            title={t("worktree.newWorktree")}
            onClick={() => onNewWorktree(parentId)}
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors duration-150 hover:bg-background-tertiary-hover/55 hover:text-foreground-icon-primary"
          >
            <Plus aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <SidebarDisclosure expanded={!collapsed}>
        <div className="flex w-full flex-col gap-0.5">
          {pending.map((p) => (
            <WorktreeProgressRow key={p.creationId} pending={p} />
          ))}
          {children.map((child) => {
            const expanded = isRepoExpanded(child);
            return (
              <div key={child.id ?? child.label} className="flex w-full flex-col">
                <WorktreeChildRow
                  repo={child}
                  expanded={expanded}
                  active={!!activeThreadId && child.threads.some((th) => threadContains(th, activeThreadId))}
                  onToggleOpen={() => onToggleRepo(child)}
                  onNewSession={onNewSession}
                  onContextMenu={
                    onRepoContextMenu && child.id
                      ? (event) => onRepoContextMenu(event, child.id!)
                      : undefined
                  }
                />
                <div className="ml-4">
                  <RepoThreadList
                    expanded={expanded}
                    threads={child.threads}
                    threadLimit={child.threadLimit}
                    activeThreadId={activeThreadId}
                    onThreadSelect={onThreadSelect}
                    onThreadAction={onThreadAction}
                    onThreadContextMenu={onThreadContextMenu}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SidebarDisclosure>
    </div>
  );
}

/** Sidebar disclosure close animation length. Content unmounts when it ends,
 *  so the next expand remounts thread pagination at page 0. */
const SIDEBAR_COLLAPSE_MS = 300;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Height disclosure shared by the sidebar's expandable regions (repo thread
 *  lists, the WORKTREES group): the grid track goes 1fr ⇄ 0fr so the region's
 *  real box grows and shrinks and the rows below are pushed smoothly.
 *  Content stays mounted until the close animation ends (instant unmount
 *  pops; unmount + opacity fade leaves a compositor ghost), then drops out of
 *  the DOM and the a11y tree. Reduced motion cuts straight to the end. */
export function SidebarDisclosure({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(expanded);
  useLayoutEffect(() => {
    if (expanded) {
      setMounted(true);
      return;
    }
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => setMounted(false), SIDEBAR_COLLAPSE_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded]);

  return (
    <div
      aria-hidden={!expanded}
      {...(!expanded ? { inert: "" } : {})}
      className={cx(
        "grid transition-[grid-template-rows] duration-300 ease-in-out motion-reduce:transition-none",
        expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
    </div>
  );
}

/** The collapsible thread area under a repo row, animated by
 *  `SidebarDisclosure` (height clips shut, no opacity fade). */
/** Pagination operates on roots; descendants always travel with their parent. */
function ThreadTreeItem({ thread, activeThreadId, onSelect, onAction, onContextMenu, workspaceKey, flat = false, nested = false }: {
  thread: AiChatThread;
  activeThreadId?: string;
  onSelect?: (id: string) => void;
  onAction?: (id: string, action: ThreadAction) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
  workspaceKey: string;
  flat?: boolean;
  nested?: boolean;
}) {
  const { t } = useTranslation();
  const identity = `${workspaceKey}/${thread.leaderBranch?.id ?? thread.id ?? thread.label}`;
  const expanded = useLeaderTreeUI((s) => s.expanded.has(identity));
  const containsSelectedDescendant = !!activeThreadId && !!thread.children?.some((child) => threadContains(child, activeThreadId));
  useEffect(() => {
    if (containsSelectedDescendant) useLeaderTreeUI.getState().reveal(identity);
  }, [activeThreadId, identity, containsSelectedDescendant]);
  const count = thread.children?.length ?? 0;
  return <div>
    <ThreadItem {...thread} workspaceLabel={flat && nested ? undefined : thread.workspaceLabel}
      flat={flat} isSelected={thread.id ? thread.id === activeThreadId : thread.isSelected}
      onSelect={onSelect} onAction={onAction} onContextMenu={onContextMenu}
      disclosure={count ? <button type="button" aria-expanded={expanded} aria-label={t("leader.toggleChildren", { count })}
        className={cx("flex shrink-0 items-center gap-0.5 text-foreground-icon-secondary", flat ? "w-7" : "-ml-5")} onClick={() => useLeaderTreeUI.getState().toggle(identity)}>
        <ChevronRight aria-hidden className={cx("size-3 transition-transform duration-300 motion-reduce:transition-none", expanded && "rotate-90")} />
        <span className="text-caption-2-medium">{count}</span>
      </button> : undefined} />
    {!!count && <SidebarDisclosure expanded={expanded}>
      <div className="ml-7 border-l border-border-button-default pl-1">
        {thread.children!.map((child) => <ThreadTreeItem key={child.leaderBranch?.id ?? child.id} thread={child} activeThreadId={activeThreadId}
          onSelect={onSelect} onAction={onAction} onContextMenu={onContextMenu} workspaceKey={workspaceKey} flat={flat} nested />)}
      </div>
    </SidebarDisclosure>}
  </div>;
}

function RepoThreadList({
  expanded,
  threads,
  threadLimit,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
  trailing,
}: {
  expanded: boolean;
  threads: AiChatThread[];
  threadLimit?: number;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
  /** Rendered after the thread rows inside the same collapse animation (the
   *  parent repo's WORKTREES group), so it folds away with the threads. */
  trailing?: ReactNode;
}) {
  return (
    <SidebarDisclosure expanded={expanded}>
      <PagedThreadList
        expanded={expanded}
        threads={threads}
        threadLimit={threadLimit}
        activeThreadId={activeThreadId}
        onThreadSelect={onThreadSelect}
        onThreadAction={onThreadAction}
        onThreadContextMenu={onThreadContextMenu}
      />
      {trailing}
    </SidebarDisclosure>
  );
}

/** Paged thread rows with the tree connector and the show-more/fewer
 *  pagination buttons. The parent keeps this instance mounted throughout
 *  the close animation, then unmounts it; the next expand therefore starts
 *  at page 0 without changing page or connector height mid-collapse. */
function PagedThreadList({
  expanded,
  threads,
  threadLimit,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
}: {
  expanded: boolean;
  threads: AiChatThread[];
  threadLimit?: number;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
}) {

  const { t } = useTranslation();
  // Pagination: 0 = 初始 limit 条, 1 = +50 条, 2 = 全部。收起动画结束前组件保持
  // 挂载，重开后重新挂载即从 page 0 开始；动画期间快速重开时在 render 中直接
  // 调整（React 推荐的 adjust-state-during-render 模式，effect 会先闪一帧旧页）。
  const [page, setPage] = useState(0);
  const [prevExpanded, setPrevExpanded] = useState(expanded);
  const [revealedChild, setRevealedChild] = useState<string | undefined>();
  if (activeThreadId && revealedChild !== activeThreadId && threads.some((row) => row.children?.some((child) => threadContains(child, activeThreadId)))) {
    setRevealedChild(activeThreadId);
    const rootIndex = threads.findIndex((row) => threadContains(row, activeThreadId));
    if (rootIndex >= (threadLimit ?? threads.length)) setPage(2);
  }
  if (prevExpanded !== expanded) {
    setPrevExpanded(expanded);
    if (expanded) setPage(0);
  }
  const { visibleThreads, hiddenCount } = paginateThreads(threads, threadLimit, page);
  const pageButtonClasses =
    "flex w-full cursor-pointer items-center rounded-2lg py-[5px] pr-2 pl-4 text-caption-1-medium text-text-tertiary transition-colors duration-150 ease hover:bg-background-secondary-hover hover:text-text-secondary";
  return (
    <div className="relative flex w-full flex-col gap-0.5 pt-0.5">
      {!visibleThreads.some((thread) => thread.children?.length) && <TreeConnector count={visibleThreads.length} />}
      {visibleThreads.map((thread) => (
        <ThreadTreeItem
          key={thread.id ?? thread.label}
          thread={thread}
          activeThreadId={activeThreadId}
          workspaceKey={threadTreeWorkspaceKey(thread, threads)}
          onSelect={onThreadSelect}
          onAction={onThreadAction}
          onContextMenu={onThreadContextMenu}
        />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setPage((value) => value + 1)}
          className={pageButtonClasses}
        >
          <span className="truncate">{t("chat.showMoreSessions")}</span>
        </button>
      ) : null}
      {page > 0 ? (
        <button
          type="button"
          onClick={() => setPage(0)}
          className={pageButtonClasses}
        >
          {t("chat.showFewerSessions")}
        </button>
      ) : null}
    </div>
  );
}

/** Expandable repo folder: clicking the row (or the folder icon) toggles the
 *  thread list; row hover reveals per-row actions — new session, drag
 *  handle (press to reorder, no long-press), remove. */
export function RepoItem({
  repo,
  open,
  onToggleOpen,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
  onRemove,
  onNewSession,
  onContextMenu,
  onRepoContextMenu,
  onNewWorktree,
  isRepoExpanded,
  onToggleRepo,
  isDragging = false,
  dragHandleProps = null,
}: {
  repo: AiChatRepo;
  /** Expanded state, owned by the sidebar so it can persist across restarts. */
  open: boolean;
  onToggleOpen?: () => void;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  /** Right-click on a thread row: opens the thread context menu. */
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
  onRemove?: (id: string) => void;
  /** Per-row + button: start a new chat in this workspace. */
  onNewSession?: (id: string) => void;
  /** Right-click on the repo header row: opens the workspace menu. */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Right-click on a worktree child row: same menu, worktree entries. */
  onRepoContextMenu?: (event: ReactMouseEvent<HTMLElement>, workspaceId: string) => void;
  /** WORKTREES group ＋ button: open the create dialog for this repo. */
  onNewWorktree?: (workspaceId: string) => void;
  /** Expansion state accessors for worktree child rows (sidebar-owned). */
  isRepoExpanded?: (repo: AiChatRepo) => boolean;
  onToggleRepo?: (repo: AiChatRepo) => void;
  /** Drag-handle reorder in progress for this row. */
  isDragging?: boolean;
  /** Immediate drag entry attached to the row's grip handle. */
  dragHandleProps?: DragHandleProps | null;
}) {
  const dragDownPos = useRef<{ x: number; y: number } | null>(null);
  const expanded = open;
  const toggleOpen = useCallback(() => onToggleOpen?.(), [onToggleOpen]);
  const hasHoverActions = Boolean(
    (repo.id && onNewSession) || dragHandleProps || (repo.id && onRemove),
  );

  return (
    <div className="flex w-full flex-col">
      <RepoHeaderRow
        repo={repo}
        expanded={expanded}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
        hasHoverActions={hasHoverActions}
        dragDownPos={dragDownPos}
        onToggleOpen={toggleOpen}
        onNewSession={onNewSession}
        onRemove={onRemove}
        onContextMenu={onContextMenu}
      />
      <RepoThreadList
        expanded={expanded}
        threads={repo.threads}
        threadLimit={repo.threadLimit}
        activeThreadId={activeThreadId}
        onThreadSelect={onThreadSelect}
        onThreadAction={onThreadAction}
        onThreadContextMenu={onThreadContextMenu}
        trailing={
          isRepoExpanded && onToggleRepo ? (
            <WorktreeGroup
              parent={repo}
              activeThreadId={activeThreadId}
              isRepoExpanded={isRepoExpanded}
              onToggleRepo={onToggleRepo}
              onThreadSelect={onThreadSelect}
              onThreadAction={onThreadAction}
              onThreadContextMenu={onThreadContextMenu}
              onRepoContextMenu={onRepoContextMenu}
              onNewWorktree={onNewWorktree}
              onNewSession={onNewSession}
            />
          ) : undefined
        }
      />
    </div>
  );
}

/** 【全部会话】跨工作区的任务树列表，以根分页；选中后代时揭示其根。 */
export function RecentThreadList({
  threads,
  threadLimit,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
}: {
  threads: RecentThread[];
  threadLimit?: number;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [revealed, setRevealed] = useState<string | undefined>();
  if (activeThreadId && revealed !== activeThreadId) {
    setRevealed(activeThreadId);
    const index = threads.findIndex((thread) => threadContains(thread, activeThreadId));
    if (index >= (threadLimit ?? threads.length)) setPage(2);
  }
  if (threads.length === 0) {
    return <p className="px-2 text-body-regular text-text-tertiary">{t("chat.noSessions")}</p>;
  }
  const { visibleThreads, hiddenCount } = paginateThreads(threads, threadLimit, page);
  return (
    <div className="flex w-full flex-col gap-0.5">
      {visibleThreads.map((thread, index) => (
        <ThreadTreeItem
          key={thread.id ?? thread.label}
          thread={thread}
          flat
          activeThreadId={activeThreadId}
          workspaceKey={threads[index].treeWorkspaceKey ?? threadTreeWorkspaceKey(thread, threads)}
          onSelect={onThreadSelect}
          onAction={onThreadAction}
          onContextMenu={onThreadContextMenu}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setPage((current) => current + 1)}
          className="flex w-full cursor-pointer items-center rounded-2lg py-[5px] pr-2 pl-2 text-caption-1-medium text-text-tertiary transition-colors duration-150 ease hover:bg-background-secondary-hover hover:text-text-secondary"
        >
          <span className="truncate">{t("chat.showMoreSessions")}</span>
        </button>
      )}
    </div>
  );
}
