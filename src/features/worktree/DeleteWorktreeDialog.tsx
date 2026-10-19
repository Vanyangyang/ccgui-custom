import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { useTerminalStore } from "@/features/terminal/store";
import { ipc, worktreeMetaOf, type Workspace } from "@/lib/ipc";
import { useWorktreeStore } from "./store";

/** 预检结果：null = 还在加载。 */
interface Preflight {
  uncommitted: number;
  /** 前两个有变更的文件名（行内示例）。 */
  samples: string[];
  unpushed: number;
  /** null = 无法判定（无分支信息或查询失败），不显示未合入行。 */
  merged: boolean | null;
  /** git lock 原因（"" = locked 但无理由）；null = 未锁定。 */
  locked: string | null;
}

/** Preloads git status / merged state / lock state for the worktree. */
function useDeletePreflight(
  workspacePath: string,
  repoPath: string | undefined,
  branch: string | null,
  baseRef: string,
): Preflight | null {
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [statusRes, mergedRes, listRes] = await Promise.allSettled([
        ipc.gitStatus(workspacePath),
        branch && repoPath ? ipc.gitBranchMerged(repoPath, branch, baseRef) : Promise.resolve(null),
        repoPath ? ipc.gitWorktreeList(repoPath) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const status = statusRes.status === "fulfilled" ? statusRes.value : null;
      const files = status ? [...status.staged, ...status.unstaged, ...status.untracked] : [];
      const entry =
        listRes.status === "fulfilled" && listRes.value
          ? listRes.value.find((w) => w.path === workspacePath)
          : undefined;
      setPreflight({
        uncommitted: files.length,
        samples: files.slice(0, 2).map((f) => f.path),
        unpushed: status?.ahead ?? 0,
        merged: mergedRes.status === "fulfilled" ? mergedRes.value : null,
        locked: entry?.locked ? (entry.lockReason ?? "") : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, repoPath, branch, baseRef]);

  return preflight;
}

/** Localized 「会丢什么」 warning lines for the confirmation body. */
function buildWarnings(
  t: TFunction,
  preflight: Preflight | null,
  branch: string | null,
  baseRef: string,
): string[] {
  const warnings: string[] = [];
  if (preflight) {
    if (preflight.uncommitted > 0) {
      warnings.push(
        t("worktree.deleteUncommitted", {
          count: preflight.uncommitted,
          samples: preflight.samples.join("、"),
        }),
      );
    }
    if (preflight.unpushed > 0) {
      warnings.push(t("worktree.deleteUnpushed", { count: preflight.unpushed }));
    }
    if (preflight.merged === false && branch) {
      warnings.push(t("worktree.deleteUnmerged", { branch, base: baseRef }));
    }
  }
  return warnings;
}

/** Preflight body: loading spinner, lock alert, or the warning list plus the
 *  busy-session notice. */
function DeleteStatusPanel({
  preflight,
  locked,
  warnings,
  busy,
}: {
  preflight: Preflight | null;
  locked: boolean;
  warnings: string[];
  busy: boolean;
}) {
  const { t } = useTranslation();
  if (preflight == null) {
    return (
      <div className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
        <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        {t("common.loading")}
      </div>
    );
  }
  if (locked) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg bg-background-secondary-default p-2.5 text-body-medium text-text-error-primary">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        {preflight.locked || t("worktree.lockedDeleteDisabled")}
      </div>
    );
  }
  return (
    <>
      {warnings.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg bg-background-secondary-default p-2.5">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-text-warning-primary" />
          <ul className="flex min-w-0 flex-col gap-0.5 text-body-medium text-text-secondary">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="text-body-medium text-text-secondary">{t("worktree.deleteClean")}</div>
      )}
      {busy && (
        <div className="flex items-start gap-2 rounded-lg bg-background-secondary-default p-2.5 text-body-medium text-text-secondary">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-text-warning-primary" />
          {t("worktree.deleteBusyWarning")}
        </div>
      )}
    </>
  );
}

/** Optional 「同时删除分支」 checkbox with its hint. */
function DeleteBranchOption({
  branch,
  baseRef,
  deleteBranch,
  onDeleteBranchChange,
  disabled,
}: {
  branch: string;
  baseRef: string;
  deleteBranch: boolean;
  onDeleteBranchChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <Checkbox
        size="sm"
        isSelected={deleteBranch}
        onChange={onDeleteBranchChange}
        isDisabled={disabled}
      >
        {t("worktree.deleteBranchOption", { branch })}
      </Checkbox>
      <span className="pl-6 text-caption-1-regular text-text-tertiary">
        {t("worktree.deleteBranchHint", { base: baseRef })}
      </span>
    </div>
  );
}

/** Confirm label: unregister-only / delete-with-branch / plain delete. */
function submitLabel(
  t: TFunction,
  hasRepo: boolean,
  deleteBranch: boolean,
  branch: string | null,
): string {
  if (!hasRepo) return t("worktree.deleteUnregisterSubmit");
  if (deleteBranch && branch) return t("worktree.deleteSubmitWithBranch");
  return t("worktree.deleteSubmit");
}

/** Footer: error line, cancel, and the danger confirm button. */
function DeleteDialogFooter({
  repoPath,
  branch,
  deleteBranch,
  canSubmit,
  submitError,
  onCancel,
  onSubmit,
}: {
  repoPath: string | undefined;
  branch: string | null;
  deleteBranch: boolean;
  canSubmit: boolean;
  submitError: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {submitError && (
        <div role="alert" className="text-caption-1-regular text-text-error-primary">
          {submitError}
        </div>
      )}
      <div className="mt-1 flex justify-end gap-2 border-t border-separator-border pt-3">
        <Button variant="secondary" size="small" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          size="small"
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {submitLabel(t, repoPath != null, deleteBranch, branch)}
        </Button>
      </div>
    </>
  );
}

/** 删除 worktree 的分级确认：预加载 git status / 合入状态 / 锁定状态，
 *  把「会丢什么」说清楚；默认保守（不删分支）。确认后对话框即关，删除
 *  走 store.remove 后台执行。 */
export function DeleteWorktreeDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const meta = worktreeMetaOf(workspace);
  const branch = meta?.branch ?? null;
  const baseRef = meta?.baseRef ?? "main";
  const parent = useChatStore((s) => s.workspaces.find((w) => w.id === workspace.parentId));
  const repoPath = parent?.path;

  // 进行中保护：该 worktree 有流式会话或活着的终端页签时额外提示。
  const hasStreaming = useChatStore((s) =>
    s.openTabs.some(
      (tab) =>
        tab.workspacePath === workspace.path &&
        s.streamingByKey[sessionKey(tab.engine, tab.sessionId, tab.workspacePath)],
    ),
  );
  const hasTerminals = useTerminalStore(
    (s) => (s.tabsByWorkspace[workspace.path] ?? []).length > 0,
  );

  const preflight = useDeletePreflight(workspace.path, repoPath, branch, baseRef);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const locked = preflight?.locked != null;
  const canSubmit = preflight != null && !locked && !submitting;
  const warnings = buildWarnings(t, preflight, branch, baseRef);

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    if (!repoPath) {
      // 父行已从侧栏消失：无法定位主仓库，退化为仅移除登记（目录/分支不动）。
      void import("@/features/chat/store").then(({ useChatStore }) => {
        void useChatStore
          .getState()
          .removeWorkspace(workspace.id)
          .then(onClose)
          .catch((error: unknown) => {
            setSubmitting(false);
            setSubmitError(String(error));
          });
      });
      return;
    }
    useWorktreeStore.getState().remove({
      workspaceId: workspace.id,
      worktreePath: workspace.path,
      repoPath,
      branch,
      deleteBranch,
    });
    onClose();
  };

  return (
    <ModalShell
      label={t("worktree.deleteTitle", { branch: branch ?? workspace.name })}
      onClose={onClose}
      className="w-[26rem]"
    >
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-title-3-semibold text-text-primary">
            {t("worktree.deleteTitle", { branch: branch ?? workspace.name })}
          </h3>
          <div className="mt-0.5 truncate text-caption-1-regular text-text-tertiary" title={workspace.path}>
            {workspace.path}
          </div>
        </div>

        {!repoPath && (
          <div className="flex items-start gap-2 rounded-lg bg-background-secondary-default p-2.5 text-body-medium text-text-secondary">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-text-warning-primary" />
            {t("worktree.deleteParentMissing")}
          </div>
        )}

        <DeleteStatusPanel
          preflight={preflight}
          locked={locked}
          warnings={warnings}
          busy={hasStreaming || hasTerminals}
        />

        {repoPath && branch && !locked && (
          <DeleteBranchOption
            branch={branch}
            baseRef={baseRef}
            deleteBranch={deleteBranch}
            onDeleteBranchChange={setDeleteBranch}
            disabled={preflight == null}
          />
        )}

        <div className="text-caption-1-regular text-text-tertiary">
          {t("worktree.deleteSessionsKept")}
        </div>

        <DeleteDialogFooter
          repoPath={repoPath}
          branch={branch}
          deleteBranch={deleteBranch}
          canSubmit={canSubmit}
          submitError={submitError}
          onCancel={onClose}
          onSubmit={submit}
        />
      </div>
    </ModalShell>
  );
}
