import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore, type CSSProperties, type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Minus from "lucide-react/dist/esm/icons/minus";
import Undo2 from "lucide-react/dist/esm/icons/undo-2";
import { Focusable } from "react-aria-components";
import { Tooltip, TooltipContent } from "@/components/base/tooltip/tooltip";
import { ConfirmDialog } from "@/components/dialogs";
import { type GitFileEntry, type GitStatus } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { registerRuntimeCheckpointBlocker } from "@/lib/runtime-checkpoint";
import { cx } from "@/utils/cx";
import { useFilesStore } from "@/features/files/store";
import { resolveWorkspaceRepository } from "@/features/files/repositorySelection";
import { useProjectContext } from "@/features/projects/store";
import { useGitStore } from "./store";
import { ChangesPanelHeader } from "./ChangesPanelHeader";
import { CommitFooter } from "./CommitFooter";

function useVisibleGitValue<Value>(
  visible: boolean,
  select: (state: ReturnType<typeof useGitStore.getState>) => Value,
) {
  const previous = useRef<Value>();
  const subscribe = useCallback(
    (notify: () => void) => visible ? useGitStore.subscribe(notify) : () => {},
    [visible],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => visible ? select(useGitStore.getState()) : previous.current,
  );
  useLayoutEffect(() => {
    previous.current = value;
  }, [value]);
  return value;
}

export function ChangesPanel({
  workspacePath,
  repoPath,
  className,
  visible = true,
}: {
  workspacePath: string;
  /** Pin the panel to this repository instead of following the file tree's
   *  selection — for callers that render the panel outside the files
   *  context, where a global selectedPath would silently steer it. */
  repoPath?: string;
  className?: string;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const selectedPath = useFilesStore((s) => s.selectedPath);
  const repositories = useFilesStore((s) => s.repositories);
  const { roots } = useProjectContext(workspacePath);
  const gitWorkspacePath = useMemo(
    () =>
      repoPath ??
      resolveWorkspaceRepository({
        selectedPath,
        repositoryRoots: Object.keys(repositories),
        workspacePath,
        projectRoots: roots.filter((root) => root.status === "available").map((root) => root.path),
      }),
    [repositories, selectedPath, workspacePath, repoPath, roots],
  );
  const status = useVisibleGitValue(visible, (s) => s.statusByWorkspace[gitWorkspacePath]);
  const notRepo = useVisibleGitValue(visible, (s) => s.notRepoByWorkspace[gitWorkspacePath]);
  const refreshError = useVisibleGitValue(visible, (s) => s.errorByWorkspace[gitWorkspacePath]);
  const branches = useVisibleGitValue(visible, (s) => s.branchesByWorkspace[gitWorkspacePath]);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const scrollOffset = useRef(0);

  useLayoutEffect(() => {
    if (visible && scrollElement) scrollElement.scrollTop = scrollOffset.current;
  }, [visible, scrollElement]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [commitMsg, setCommitMsgState] = useState("");
  const checkpointId = useId();
  const checkpointState = useRef({ pending, commitMsg });
  checkpointState.current = { pending, commitMsg };
  const pendingOperations = useRef(0);
  const targetRef = useRef({ path: gitWorkspacePath });
  if (targetRef.current.path !== gitWorkspacePath) targetRef.current = { path: gitWorkspacePath };
  const commitDrafts = useRef(new Map<string, string>());
  const setCommitMsg = useCallback((value: string) => {
    if (value) commitDrafts.current.set(targetRef.current.path, value);
    else commitDrafts.current.delete(targetRef.current.path);
    checkpointState.current.commitMsg = value;
    setCommitMsgState(value);
  }, []);
  useEffect(() => registerRuntimeCheckpointBlocker(`git-changes:${checkpointId}`, () => [
    ...(checkpointState.current.commitMsg.length || commitDrafts.current.size ? ["unsaved-git-commit-message"] : []),
    ...(pendingOperations.current || Object.keys(checkpointState.current.pending).length ? ["git-operation-pending"] : []),
  ]), [checkpointId]);
  /** Paths awaiting discard confirmation (one row or a whole group). */
  const [discardTarget, setDiscardTarget] = useState<string[] | null>(null);
  useLayoutEffect(() => {
    setDiscardTarget(null);
    setCommitMsg(commitDrafts.current.get(gitWorkspacePath) ?? "");
    setActionError(null);
    setPending({});
  }, [gitWorkspacePath, setCommitMsg]);

  useEffect(() => {
    if (!visible) return;
    void useGitStore.getState().refresh(gitWorkspacePath);
    void useGitStore.getState().loadBranches(gitWorkspacePath);
  }, [gitWorkspacePath, visible]);

  /** Runs a mutating action: tracks busy state, surfaces errors inline. */
  const run = useCallback((key: string, action: () => Promise<unknown>) => {
    const target = targetRef.current;
    pendingOperations.current++;
    setPending((p) => ({ ...p, [key]: true }));
    setActionError(null);
    void action()
      .catch((err: unknown) => { if (targetRef.current === target) setActionError(errorText(err)); })
      .finally(() => {
        pendingOperations.current--;
        if (targetRef.current !== target) return;
        setPending((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      });
  }, []);
  /** Dismiss the header error: the failed action's error, else the store's
   * last refresh failure. */
  const dismissError = useCallback(() => {
    setActionError(null);
    useGitStore.getState().clearError(gitWorkspacePath);
  }, [gitWorkspacePath]);

  const stage = useCallback(
    (files: string[]) =>
      run("stage", () => useGitStore.getState().stage(gitWorkspacePath, files)),
    [run, gitWorkspacePath],
  );
  const unstage = useCallback(
    (files: string[]) =>
      run("unstage", () => useGitStore.getState().unstage(gitWorkspacePath, files)),
    [run, gitWorkspacePath],
  );
  const stageOne = useCallback((file: string) => stage([file]), [stage]);
  const unstageOne = useCallback((file: string) => unstage([file]), [unstage]);
  const discard = useCallback(
    (files: string[]) =>
      run("discard", () => useGitStore.getState().discard(gitWorkspacePath, files)),
    [run, gitWorkspacePath],
  );
  const discardRow = useCallback((file: string) => setDiscardTarget([file]), []);
  const confirmDiscard = useCallback(() => {
    if (discardTarget === null) return;
    discard(discardTarget);
    setDiscardTarget(null);
  }, [discard, discardTarget]);
  // File rows open the diff in the center area, where it has room.
  const openStagedDiff = useCallback(
    (file: string) =>
      useGitStore.getState().openDiff(gitWorkspacePath, { file, staged: true }),
    [gitWorkspacePath],
  );
  const openUnstagedDiff = useCallback(
    (file: string) =>
      useGitStore.getState().openDiff(gitWorkspacePath, { file, staged: false }),
    [gitWorkspacePath],
  );

  const header = visible ? (
    <ChangesPanelHeader
      workspacePath={gitWorkspacePath}
      // Name the repository when the panel followed the file tree's
      // selection into a nested repo — otherwise a commit there looks
      // identical to one against the workspace root.
      followedRepoPath={
        repoPath === undefined && gitWorkspacePath !== workspacePath
          ? gitWorkspacePath
          : undefined
      }
      notRepo={notRepo ?? false}
      branch={status?.branch ?? branches?.find((b) => b.isCurrent)?.name}
      ahead={status?.ahead}
      behind={status?.behind}
      branches={branches}
      pending={pending}
      error={actionError ?? refreshError ?? null}
      run={run}
      onDismissError={dismissError}
    />
  ) : null;

  if (notRepo) {
    return (
      <aside style={{ display: visible ? undefined : "none" }} className={cx("flex h-full flex-col bg-background-primary-default", className)}>
        {header}
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-body-medium text-text-tertiary">
            {t("git.notARepo")}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside style={{ display: visible ? undefined : "none" }} className={cx("flex h-full min-h-0 flex-col bg-background-primary-default", className)}>
      {header}
      <div
        ref={setScrollElement}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => { if (visible) scrollOffset.current = event.currentTarget.scrollTop; }}
      >
        <ChangesBody
          status={status}
          visible={visible}
          scrollElement={scrollElement}
          scrollOffset={scrollOffset}
          pending={pending}
          stage={stage}
          unstage={unstage}
          stageOne={stageOne}
          unstageOne={unstageOne}
          discardRow={discardRow}
          setDiscardTarget={setDiscardTarget}
          openStagedDiff={openStagedDiff}
          openUnstagedDiff={openUnstagedDiff}
        />
      </div>
      {visible && (
        <CommitFooter
          workspacePath={gitWorkspacePath}
          stagedCount={status?.staged.length ?? 0}
          busy={pending.commit === true}
          commitMsg={commitMsg}
          onCommitMsgChange={setCommitMsg}
          run={run}
        />
      )}
      {visible && discardTarget !== null && (
        <ConfirmDialog
          danger
          message={
            discardTarget.length === 1
              ? t("git.discardConfirm", { path: discardTarget[0] })
              : t("git.discardAllConfirm", { count: discardTarget.length })
          }
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardTarget(null)}
        />
      )}
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

/** Scrollable body: loading / empty placeholder, or the three file groups. */
function ChangesBody({
  status,
  visible,
  scrollElement,
  scrollOffset,
  pending,
  stage,
  unstage,
  stageOne,
  unstageOne,
  discardRow,
  setDiscardTarget,
  openStagedDiff,
  openUnstagedDiff,
}: {
  status: GitStatus | undefined;
  visible: boolean;
  scrollElement: HTMLDivElement | null;
  scrollOffset: RefObject<number>;
  pending: Record<string, true>;
  stage: (files: string[]) => void;
  unstage: (files: string[]) => void;
  stageOne: (file: string) => void;
  unstageOne: (file: string) => void;
  discardRow: (file: string) => void;
  setDiscardTarget: (target: string[] | null) => void;
  openStagedDiff: (file: string) => void;
  openUnstagedDiff: (file: string) => void;
}) {
  const { t } = useTranslation();
  if (!status) return <ChangesPlaceholder text={t("common.loading")} />;
  const total = status.staged.length + status.unstaged.length + status.untracked.length;
  if (total === 0) return <ChangesPlaceholder text={t("git.noChanges")} />;
  return (
    <>
      <ChangesSummary status={status} />
      <GroupSection
        visible={visible}
        scrollElement={scrollElement}
        scrollOffset={scrollOffset}
        title={t("git.staged")}
        entries={status.staged}
        groupActionLabel={t("git.unstageAll")}
        onGroupAction={unstage}
        rowActionLabel={t("git.unstage")}
        rowActionKind="unstage"
        onRowAction={unstageOne}
        onOpen={openStagedDiff}
        actionBusy={pending.unstage === true}
      />
      <GroupSection
        visible={visible}
        scrollElement={scrollElement}
        scrollOffset={scrollOffset}
        title={t("git.unstaged")}
        entries={status.unstaged}
        groupActionLabel={t("git.stageAll")}
        onGroupAction={stage}
        rowActionLabel={t("git.stage")}
        rowActionKind="stage"
        onRowAction={stageOne}
        rowDiscardLabel={t("git.discard")}
        onRowDiscard={discardRow}
        groupDiscardLabel={t("git.discardAll")}
        onGroupDiscard={setDiscardTarget}
        onOpen={openUnstagedDiff}
        actionBusy={pending.stage === true}
      />
      <GroupSection
        visible={visible}
        scrollElement={scrollElement}
        scrollOffset={scrollOffset}
        title={t("git.untracked")}
        entries={status.untracked}
        groupActionLabel={t("git.stageAll")}
        onGroupAction={stage}
        rowActionLabel={t("git.stage")}
        rowActionKind="stage"
        onRowAction={stageOne}
        rowDiscardLabel={t("git.discard")}
        onRowDiscard={discardRow}
        groupDiscardLabel={t("git.discardAll")}
        onGroupDiscard={setDiscardTarget}
        onOpen={openUnstagedDiff}
        actionBusy={pending.stage === true}
        isNew
      />
    </>
  );
}

/** Centered loading / no-changes placeholder. */
function ChangesPlaceholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <p className="text-body-medium text-text-tertiary">{text}</p>
    </div>
  );
}

const ChangesSummary = memo(function ChangesSummary({ status }: { status: GitStatus }) {
  const { t } = useTranslation();
  const all = [...status.staged, ...status.unstaged, ...status.untracked];
  const adds = all.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = all.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-separator-border bg-background-primary-default px-3 py-2">
      <span className="text-body-medium text-text-primary">
        {all.length} {t("git.uncommittedChanges")}
      </span>
      <span className="text-xs text-state-success-text">+{adds}</span>
      <span className="text-xs text-text-error-primary">−{dels}</span>
    </div>
  );
});

const STATUS_COLOR: Record<string, string> = {
  M: "text-status-yellow-text",
  A: "text-state-success-text",
  D: "text-text-error-primary",
  R: "text-status-purple-text",
  C: "text-status-blue-text",
};

interface GroupSectionProps {
  visible: boolean;
  scrollElement: HTMLDivElement | null;
  scrollOffset: RefObject<number>;
  title: string;
  entries: GitFileEntry[];
  groupActionLabel: string;
  onGroupAction: (files: string[]) => void;
  rowActionLabel: string;
  rowActionKind: "stage" | "unstage";
  onRowAction: (file: string) => void;
  /** Discard is destructive and only meaningful for worktree-side groups
   *  (unstaged/untracked); staged rows get no discard button. */
  rowDiscardLabel?: string;
  onRowDiscard?: (file: string) => void;
  /** Red group-level discard next to the stage-all action, same groups. */
  groupDiscardLabel?: string;
  onGroupDiscard?: (files: string[]) => void;
  onOpen: (file: string) => void;
  actionBusy: boolean;
  isNew?: boolean;
}

const GroupSection = memo(function GroupSection({
  visible,
  scrollElement,
  scrollOffset,
  title,
  entries,
  groupActionLabel,
  onGroupAction,
  rowActionLabel,
  rowActionKind,
  onRowAction,
  rowDiscardLabel,
  onRowDiscard,
  groupDiscardLabel,
  onGroupDiscard,
  onOpen,
  actionBusy,
  isNew = false,
}: GroupSectionProps) {
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtual = entries.length > 40;
  useLayoutEffect(() => {
    const scroller = scrollElement;
    if (!visible || !open || !virtual || !scroller) return;
    const measure = () => {
      if (!listRef.current) return;
      setScrollMargin(
        listRef.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [visible, open, virtual, entries.length, scrollElement]);
  const getItemKey = useCallback((index: number) => entries[index].path, [entries]);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 32,
    getItemKey,
    overscan: 5,
    scrollMargin,
    initialOffset: () => scrollOffset.current ?? 0,
    enabled: visible && open && virtual,
  });
  if (entries.length === 0) return <section hidden />;
  const rows = !visible ? [] : virtual ? virtualizer.getVirtualItems() : entries.map((entry, index) => ({
    key: entry.path,
    index,
    start: index * 32 + scrollMargin,
    size: 32,
  }));
  return (
    <section>
      <div
        className={cx(
          "sticky top-[33px] z-10 flex items-center gap-1 bg-background-secondary-default px-3 py-1.5",
          "border-b border-separator-border",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-4 text-foreground-icon-tertiary" />
          ) : (
            <ChevronRight aria-hidden className="size-4 text-foreground-icon-tertiary" />
          )}
          <span className="text-body-medium text-text-secondary">{title}</span>
          <span className="text-xs text-text-tertiary">{entries.length}</span>
        </button>
        {groupDiscardLabel !== undefined && onGroupDiscard !== undefined && (
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => onGroupDiscard(entries.map((f) => f.path))}
            className={cx(
              "shrink-0 rounded px-1.5 py-0.5 text-xs text-text-error-primary",
              "hover:bg-background-tertiary-hover disabled:text-text-disabled",
            )}
          >
            {groupDiscardLabel}
          </button>
        )}
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => onGroupAction(entries.map((f) => f.path))}
          className={cx(
            "shrink-0 rounded px-1.5 py-0.5 text-xs text-text-secondary",
            "hover:bg-background-tertiary-hover disabled:text-text-disabled",
          )}
        >
          {groupActionLabel}
        </button>
      </div>
      {open && (
        <ul ref={listRef} className="relative" style={{ height: entries.length * 32 }}>
          {rows.map((row) => (
            <FileRow
              key={row.key}
              entry={entries[row.index]}
              style={{
                position: "absolute", top: 0, left: 0, width: "100%",
                height: row.size, transform: `translateY(${row.start - scrollMargin}px)`,
              }}
              actionLabel={rowActionLabel}
              actionKind={rowActionKind}
              onAction={onRowAction}
              discardLabel={rowDiscardLabel}
              onDiscard={onRowDiscard}
              onOpen={onOpen}
              actionBusy={actionBusy}
              isNew={isNew}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

interface FileRowProps {
  entry: GitFileEntry;
  style?: CSSProperties;
  actionLabel: string;
  actionKind: "stage" | "unstage";
  /** Untracked group: show the "New" badge like the template panel. */
  isNew?: boolean;
  /** Present only on worktree-side rows; opens the discard confirmation. */
  discardLabel?: string;
  onDiscard?: (path: string) => void;
  onAction: (path: string) => void;
  onOpen: (path: string) => void;
  actionBusy: boolean;
}

const FileRow = memo(function FileRow({
  entry,
  style,
  actionLabel,
  actionKind,
  isNew = false,
  discardLabel,
  onDiscard,
  onAction,
  onOpen,
  actionBusy,
}: FileRowProps) {
  const { t } = useTranslation();
  const raw = entry.status.replace("?", "").trim().charAt(0).toUpperCase();
  const letter = raw.length > 0 ? raw : "?";
  const sepIdx = Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\"));
  const dirPart = sepIdx > 0 ? entry.path.slice(0, sepIdx + 1) : "";
  const filePart = sepIdx >= 0 ? entry.path.slice(sepIdx + 1) : entry.path;
  return (
    <li style={style} className="group relative grid min-h-8 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-1.5 px-3 hover:bg-background-secondary-hover">
      <span
        className={cx(
          "w-4 shrink-0 text-center font-mono text-xs",
          STATUS_COLOR[letter] ?? "text-text-tertiary",
        )}
      >
        {letter}
      </span>
      <Tooltip>
        <Focusable>
          <button
            type="button"
            onClick={() => onOpen(entry.path)}
            aria-label={isNew ? `${entry.path} (${t("git.newFile")})` : undefined}
            className="flex min-w-0 items-baseline overflow-hidden text-left font-mono text-xs"
          >
            {/* Directory truncates from the left (…/foo/bar) so the filename
                — the most important part — stays visible as long as possible;
                it right-truncates only when it alone overflows. The tooltip
                below shows the full path on hover. */}
            {dirPart && (
              <span dir="rtl" className="min-w-0 truncate text-left text-text-tertiary">
                <bdo dir="ltr">{dirPart}</bdo>
              </span>
            )}
            <span className="min-w-0 truncate text-text-primary">{filePart}</span>
          </button>
        </Focusable>
        <TooltipContent className="break-all font-mono">{entry.path}</TooltipContent>
      </Tooltip>
      <span className="flex min-w-0 items-center justify-end gap-1 font-mono text-xs tabular-nums">
        {isNew && (
          <Tooltip>
            <Focusable>
              <span
                role="img"
                aria-label={t("git.newFile")}
                className="size-1.5 shrink-0 rounded-full bg-notification-success-foreground"
              />
            </Focusable>
            <TooltipContent>{t("git.newFile")}</TooltipContent>
          </Tooltip>
        )}
        {entry.additions !== undefined && (
          <span className="truncate text-state-success-text">+{entry.additions}</span>
        )}
        {entry.deletions !== undefined && entry.deletions > 0 && (
          <span className="truncate text-text-error-primary">−{entry.deletions}</span>
        )}
      </span>
      <div
        // Row actions overlay the trailing edge instead of reserving
        // permanent columns, so path + stats use the full row width. The
        // solid background (matching the row's own bg in each state) hides
        // the text underneath; reveal happens on row hover or keyboard
        // focus within the row.
        className={cx(
          "absolute inset-y-0 right-1.5 flex items-center gap-0.5 pl-3",
          "bg-background-primary-default group-hover:bg-background-secondary-hover",
          "pointer-events-none opacity-0",
          "group-hover:pointer-events-auto group-hover:opacity-100",
          "focus-within:pointer-events-auto focus-within:opacity-100",
        )}
      >
        {discardLabel !== undefined && onDiscard !== undefined && (
          <Tooltip>
            <Focusable>
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => onDiscard(entry.path)}
                aria-label={discardLabel}
                className={cx(
                  "rounded p-0.5 text-foreground-icon-secondary",
                  "hover:bg-background-tertiary-hover disabled:text-foreground-icon-disabled",
                )}
              >
                <Undo2 aria-hidden className="size-4" />
              </button>
            </Focusable>
            <TooltipContent>{discardLabel}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <Focusable>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => onAction(entry.path)}
              aria-label={actionLabel}
              className={cx(
                "rounded p-0.5 text-foreground-icon-secondary",
                "hover:bg-background-tertiary-hover disabled:text-foreground-icon-disabled",
              )}
            >
              {actionKind === "stage" ? (
                <Plus aria-hidden className="size-4" />
              ) : (
                <Minus aria-hidden className="size-4" />
              )}
            </button>
          </Focusable>
          <TooltipContent>{actionLabel}</TooltipContent>
        </Tooltip>
      </div>
    </li>
  );
});
