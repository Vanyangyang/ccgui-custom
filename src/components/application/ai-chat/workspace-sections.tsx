"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Folders from "lucide-react/dist/esm/icons/folders";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import History from "lucide-react/dist/esm/icons/history";
import ListChecks from "lucide-react/dist/esm/icons/list-checks";
import {
  WORKSPACE_DROP_TARGET_ATTR,
  WorkspaceSortableList,
} from "@/components/application/ai-chat/workspace-sortable-list";
import { ARCHIVED_SECTION_ID } from "@/components/application/ai-chat/use-sidebar-state";
import { Input } from "@/components/base/input/input";
import { RecentThreadList, RepoItem } from "@/components/application/ai-chat/repo-tree";
import type { AiChatRepo, AiChatRepoSection, AiChatThread, ThreadAction } from "@/components/application/ai-chat/sidebar-types";
import type { SidebarChatListMode } from "@/components/application/ai-chat/use-sidebar-state";
import {
  CrossSessionCommsToggleButton,
} from "@/features/chat/components/CrossSessionCommsPanel";
import { cx } from "@/utils/cx";

/** Drop-target container chrome: the drag layer marks the hovered section
 *  with data-drop-hover; group/ungrouped/已归档 all share the look. */
const dropTargetClasses = cx(
  "flex w-full flex-col rounded-2lg transition-colors duration-150",
  "data-[drop-hover=true]:bg-background-secondary-hover data-[drop-hover=true]:ring-1 data-[drop-hover=true]:ring-border-button-active",
);

/** Workspace group header (› name): click toggles the group's
 *  repo list; collapsed state is owned (and persisted) by the sidebar. */
function GroupHeaderRow({
  name,
  collapsed,
  onToggle,
}: {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1 rounded-2lg px-1 py-[5px] transition-colors duration-150 ease hover:bg-background-secondary-hover"
    >
      <ChevronRight
        className={cx(
          "size-3.5 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
          !collapsed && "rotate-90",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-left text-caption-1-medium text-text-tertiary">
        {name}
      </span>
    </button>
  );
}

/** Inline composer for creating a group straight from the sidebar (blank-area
 *  right-click → 新建分组). Enter commits — validation errors stay inline and
 *  keep the row open; Escape or leaving the field cancels. Same rules as the
 *  settings page's GroupNameEditor, minus the confirm button the narrow
 *  sidebar row has no room for. */
function GroupComposerRow({
  placeholder,
  onCommit,
  onCancel,
}: {
  placeholder: string;
  /** Returns a localized validation error, or null when the name was accepted. */
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  return (
    <div className="flex w-full items-center gap-1 rounded-2lg px-1 py-[5px]">
      <ChevronRight className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <Input
        autoFocus
        size="small"
        className="min-w-0 flex-1"
        placeholder={placeholder}
        isInvalid={Boolean(hint)}
        hint={hint ?? undefined}
        value={value}
        onChange={(v) => {
          setValue(v);
          if (hint) setHint(null);
        }}
        onKeyDown={(e) => {
          // Enter/Escape during IME composition (e.g. picking a Chinese
          // candidate) belong to the IME — never submit or cancel.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            setHint(onCommit(value));
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={onCancel}
      />
    </div>
  );
}

/** A grayed, non-expandable archived workspace row: right-click is the only
 *  interaction (unarchive / set alias via the shared workspace menu). */
function ArchivedRepoRow({
  repo,
  onContextMenu,
}: {
  repo: AiChatRepo;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      onContextMenu={onContextMenu}
      className="flex w-full cursor-default items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
        <FolderSymlink className="size-4 text-foreground-icon-tertiary" />
      </span>
      <span
        title={repo.originalLabel}
        className="min-w-0 flex-1 truncate text-body-2-medium whitespace-nowrap text-text-tertiary"
      >
        {repo.label}
      </span>
      {repo.isSelfDev && (
        <span
          data-testid="self-dev-workspace-badge"
          title={t("chat.selfDevBadgeHint")}
          className="inline-flex shrink-0 items-center rounded-sm bg-status-purple-background px-1.5 py-px text-caption-2-medium text-status-purple-text"
        >
          {t("chat.selfDevBadge")}
        </span>
      )}
    </div>
  );
}

/** 已归档 section at the bottom of the workspace tree: collapsible like a
 *  group header (same persisted collapse set), rows are plain grayed labels. */
export function ArchivedSection({
  repos,
  collapsed,
  onToggle,
  onRepoContextMenu,
}: {
  repos: AiChatRepo[];
  collapsed: boolean;
  onToggle: () => void;
  onRepoContextMenu?: (event: ReactMouseEvent<HTMLElement>, workspaceId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...{ [WORKSPACE_DROP_TARGET_ATTR]: ARCHIVED_SECTION_ID }} className={dropTargetClasses}>
      <GroupHeaderRow
        name={t("chat.archivedWorkspaces", { count: repos.length })}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <div className="flex w-full flex-col gap-1">
          {repos.map((repo) => (
            <ArchivedRepoRow
              key={repo.id ?? repo.label}
              repo={repo}
              onContextMenu={
                onRepoContextMenu && repo.id
                  ? (event) => onRepoContextMenu(event, repo.id!)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Workspaces section: header with the add button + the sortable repo tree.
 *  With workspace groups configured, repos render under collapsible group
 *  headers (工作区二级分类); otherwise the flat list renders unchanged. */
export function WorkspaceSection({
  repos,
  sections,
  collapsedGroups,
  isRepoExpanded,
  onToggleRepo,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
  onAddWorkspace,
  onRemoveWorkspace,
  onNewSessionInWorkspace,
  onNewWorktree,
  onReorderWorkspaces,
  onToggleGroup,
  onRepoContextMenu,
  onWorkspaceDragActiveChange,
  onDropWorkspaceToSection,
  creatingGroup = false,
  onCreateGroup,
  onCreateGroupCancel,
  listMode = "workspace",
  onToggleListMode,
  onOpenCleanup,
  recentThreads,
}: {
  repos: AiChatRepo[];
  /** Grouped repo tree; absent/empty = legacy flat list. */
  sections?: AiChatRepoSection[];
  collapsedGroups: Set<string>;
  /** Sidebar-owned so expansion survives restarts. */
  isRepoExpanded: (repo: AiChatRepo) => boolean;
  onToggleRepo: (repo: AiChatRepo) => void;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  /** Right-click on a thread row (thread context menu). */
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, threadId: string) => void;
  onAddWorkspace?: () => void;
  onRemoveWorkspace?: (id: string) => void;
  onNewSessionInWorkspace?: (id: string) => void;
  /** WORKTREES group ＋ / context-menu entry: open the create dialog. */
  onNewWorktree?: (workspaceId: string) => void;
  onReorderWorkspaces?: (orderedIds: string[]) => void;
  onToggleGroup?: (groupId: string) => void;
  /** Right-click on a repo header row (workspace context menu). */
  onRepoContextMenu?: (event: ReactMouseEvent<HTMLElement>, workspaceId: string) => void;
  onWorkspaceDragActiveChange?: (active: boolean) => void;
  /** Drop of a workspace row onto a section container (group id, the
   *  archived sentinel, or null = ungrouped). */
  onDropWorkspaceToSection?: (workspaceId: string, targetSectionId: string | null) => void;
  /** Blank-area menu「新建分组」is pending: render the inline name composer
   *  at the end of the section. */
  creatingGroup?: boolean;
  /** Composer commit: returns a localized validation error to keep the row
   *  open, or null when the name was accepted. */
  onCreateGroup?: (name: string) => string | null;
  onCreateGroupCancel?: () => void;
  /** 【全部会话】workspace = 按工作区分组；recent = 按最后对话时间合成一张表。 */
  listMode?: SidebarChatListMode;
  onToggleListMode?: () => void;
  onOpenCleanup?: () => void;
  recentThreads?: AiChatThread[];
}) {
  const { t } = useTranslation();
  const hasGroups = Boolean(sections?.some((section) => section.id !== null));

  const renderRepoList = (repos: AiChatRepo[], sectionId: string | null) =>
    repos.length > 0 && (
      <WorkspaceSortableList
        items={repos}
        sectionId={sectionId}
        onDropToSection={onDropWorkspaceToSection}
        onDragActiveChange={onWorkspaceDragActiveChange}
        onReorder={
          onReorderWorkspaces
            ? (orderedIds) => {
                // Rebuild the global order: other sections keep theirs, the
                // dragged section takes the new one.
                const all = (sections ?? [{ id: null, name: "", repos }]).flatMap(
                  (section) =>
                    section.id === sectionId
                      ? orderedIds
                      : section.repos.map((repo) => repo.id),
                );
                onReorderWorkspaces(all.filter((id): id is string => Boolean(id)));
              }
            : undefined
        }
        className="flex w-full flex-col gap-1"
        renderItem={(repo, drag) => (
          <RepoItem
            repo={repo}
            open={isRepoExpanded(repo)}
            onToggleOpen={() => onToggleRepo(repo)}
            activeThreadId={activeThreadId}
            onThreadSelect={onThreadSelect}
            onThreadAction={onThreadAction}
            onThreadContextMenu={onThreadContextMenu}
            onRemove={onRemoveWorkspace}
            onNewSession={onNewSessionInWorkspace}
            onNewWorktree={onNewWorktree}
            onRepoContextMenu={onRepoContextMenu}
            isRepoExpanded={isRepoExpanded}
            onToggleRepo={onToggleRepo}
            onContextMenu={
              onRepoContextMenu && repo.id
                ? (event) => onRepoContextMenu(event, repo.id!)
                : undefined
            }
            isDragging={drag?.isDragging ?? false}
            dragHandleProps={drag?.dragHandleProps ?? null}
          />
        )}
      />
    );

  return (
    <div data-onboarding-target="workspace-section" className="flex w-full flex-col gap-2.5">
      <div
        {...{ [WORKSPACE_DROP_TARGET_ATTR]: "" }}
        className="flex w-full items-center justify-between rounded-2lg transition-colors duration-150 data-[drop-hover=true]:bg-background-secondary-hover data-[drop-hover=true]:ring-1 data-[drop-hover=true]:ring-border-button-active"
      >
        <span className="text-body-2-medium text-text-secondary">
          {listMode === "recent" ? t("chat.allSessions") : t("chat.workspaces")}
        </span>
        <span className="flex items-center gap-0.5">
          <CrossSessionCommsToggleButton />
          {onOpenCleanup && (
            <button
              type="button"
              data-testid="sidebar-cleanup-btn"
              aria-label={t("chat.cleanupOpen")}
              title={t("chat.cleanupOpen")}
              onClick={onOpenCleanup}
              className="flex size-7 cursor-pointer items-center justify-center rounded-full text-foreground-icon-secondary transition-colors duration-150 hover:bg-background-tertiary-hover/55 hover:text-foreground-icon-primary"
            >
              <ListChecks className="size-4" aria-hidden />
            </button>
          )}
          {onToggleListMode && (
            <button
              type="button"
              aria-pressed={listMode === "recent"}
              aria-label={listMode === "recent" ? t("chat.sortByWorkspace") : t("chat.sortByRecent")}
              title={listMode === "recent" ? t("chat.sortByWorkspace") : t("chat.sortByRecent")}
              onClick={onToggleListMode}
              className="flex size-7 cursor-pointer items-center justify-center rounded-full text-foreground-icon-secondary transition-colors duration-150 hover:bg-background-tertiary-hover/55 hover:text-foreground-icon-primary aria-pressed:bg-background-secondary-hover aria-pressed:text-foreground-icon-primary"
            >
              {listMode === "recent" ? (
                <Folders className="size-4" aria-hidden />
              ) : (
                <History className="size-4" aria-hidden />
              )}
            </button>
          )}
          <button
            type="button"
            aria-label={t("chat.addWorkspace")}
            title={t("chat.addWorkspace")}
            onClick={onAddWorkspace}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full text-foreground-icon-secondary transition-colors duration-150 hover:bg-background-tertiary-hover/55 hover:text-foreground-icon-primary"
          >
            <FolderPlus className="size-4" aria-hidden />
          </button>
        </span>
      </div>
      {listMode === "recent" && (
        <RecentThreadList
          threads={recentThreads ?? []}
          threadLimit={repos[0]?.threadLimit}
          activeThreadId={activeThreadId}
          onThreadSelect={onThreadSelect}
          onThreadAction={onThreadAction}
          onThreadContextMenu={onThreadContextMenu}
        />
      )}
      {listMode !== "recent" && !hasGroups && renderRepoList(repos, null)}
      {listMode !== "recent" && hasGroups &&
        sections!.map((section) =>
          section.id === null ? (
            <div key="ungrouped" {...{ [WORKSPACE_DROP_TARGET_ATTR]: "" }} className={dropTargetClasses}>
              {renderRepoList(section.repos, null)}
            </div>
          ) : (
            // Empty groups stay visible: the sidebar is where groups are
            // created now, so a fresh group must show up before it has
            // members.
            <div key={section.id} {...{ [WORKSPACE_DROP_TARGET_ATTR]: section.id }} className={dropTargetClasses}>
              <GroupHeaderRow
                name={section.name}
                collapsed={collapsedGroups.has(section.id)}
                onToggle={() => onToggleGroup?.(section.id!)}
              />
              {!collapsedGroups.has(section.id) &&
                renderRepoList(section.repos, section.id)}
            </div>
          ),
        )}
      {creatingGroup && onCreateGroup && (
        <GroupComposerRow
          placeholder={t("settings.newGroupPlaceholder")}
          onCommit={onCreateGroup}
          onCancel={onCreateGroupCancel ?? (() => {})}
        />
      )}
    </div>
  );
}
