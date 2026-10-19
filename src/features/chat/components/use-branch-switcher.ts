import { useCallback, useEffect, useMemo, useState } from "react";
import { useFilesStore } from "@/features/files/store";
import { resolveSelectedRepository } from "@/features/files/repositorySelection";
import { useGitStore } from "@/features/git/store";
import { errorText } from "@/lib/errors";
import type { ActiveSession } from "../store";

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Status-bar branch switcher. Tracks a Git repository — normally the active
 * workspace, but when the file tree selects a folder/file inside a *nested*
 * repository (a plain workspace root holding several repos), the chip, branch
 * list and checkout follow that repository instead. Selection is resolved
 * through the files store's discovered repository roots; anything else (no
 * selection, plain folder, workspace root itself) falls back to the
 * workspace, matching the previous behavior exactly. */
export function useBranchSwitcher(
  active: Pick<ActiveSession, "workspacePath"> | { workspacePath?: string | null } | null | undefined,
) {
  const workspacePath = active?.workspacePath ?? undefined;
  const selectedPath = useFilesStore((s) => s.selectedPath);
  const repositories = useFilesStore((s) => s.repositories);
  const branchRepo = useMemo(() => {
    if (!workspacePath) return null;
    return (
      resolveSelectedRepository({
        selectedPath,
        repositoryRoots: Object.keys(repositories),
        workspacePath,
      }) ?? workspacePath
    );
  }, [workspacePath, selectedPath, repositories]);
  const statusBranch = useGitStore((s) =>
    branchRepo ? s.statusByWorkspace[branchRepo]?.branch : undefined,
  );
  const notRepo = useGitStore((s) =>
    branchRepo ? s.notRepoByWorkspace[branchRepo] === true : false,
  );
  const branches = useGitStore((s) =>
    branchRepo ? s.branchesByWorkspace[branchRepo] : undefined,
  );
  // Prefer the live status branch; while `git_status` is still walking the
  // worktree, fall back to the fast ref-only `isCurrent` branch from
  // `git_branches` so the branch badge renders immediately.
  const branch = useMemo(() => {
    if (notRepo) return undefined;
    return statusBranch ?? branches?.find((b) => b.isCurrent)?.name;
  }, [notRepo, statusBranch, branches]);
  /** Display name of the followed repo when it's a nested one; the status bar
   * prefixes it to the branch so the chip never mislabels the repo. */
  const branchRepoName =
    branchRepo && workspacePath && branchRepo !== workspacePath
      ? baseName(branchRepo)
      : undefined;
  // Branch list + status feed the status-bar switcher; refresh whenever the
  // followed repository changes (30s TTL dedup lives in the git store).
  useEffect(() => {
    if (!branchRepo) return;
    const git = useGitStore.getState();
    void git.loadBranches(branchRepo);
    void git.refresh(branchRepo).catch(() => undefined);
  }, [branchRepo]);
  const reloadBranches = useCallback(() => {
    if (!branchRepo) return;
    const git = useGitStore.getState();
    void git.loadBranches(branchRepo);
    void git.refresh(branchRepo).catch(() => undefined);
  }, [branchRepo]);
  const [branchError, setBranchError] = useState<string | null>(null);
  /** Dismiss the checkout-error banner (cleared anyway on the next attempt). */
  const dismissBranchError = useCallback(() => setBranchError(null), []);
  const handleBranchSelect = useCallback(
    (name: string) => {
      if (!branchRepo) return;
      setBranchError(null);
      void useGitStore
        .getState()
        .checkout(branchRepo, name)
        .catch((err: unknown) => setBranchError(errorText(err)));
    },
    [branchRepo],
  );
  return {
    branch,
    branches,
    branchRepoName,
    branchError,
    handleBranchSelect,
    dismissBranchError,
    reloadBranches,
  };
}
