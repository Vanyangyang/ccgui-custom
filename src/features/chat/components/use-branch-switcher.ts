import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFilesStore } from "@/features/files/store";
import { resolveWorkspaceRepository } from "@/features/files/repositorySelection";
import { useProjectContext } from "@/features/projects/store";
import { useGitStore } from "@/features/git/store";
import { errorText } from "@/lib/errors";
import type { ActiveSession } from "../store";

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Status-bar branch switcher. Tracks a Git repository — normally the active
 * workspace, but follows the selected available project root and its deepest
 * discovered repository. This changes the Git target only, never session cwd. */
export function useBranchSwitcher(
  active: Pick<ActiveSession, "workspacePath"> | { workspacePath?: string | null } | null | undefined,
) {
  const workspacePath = active?.workspacePath ?? undefined;
  const selectedPath = useFilesStore((s) => s.selectedPath);
  const repositories = useFilesStore((s) => s.repositories);
  const { roots } = useProjectContext(workspacePath ?? "");
  const branchRepo = useMemo(() => {
    if (!workspacePath) return null;
    return (
      resolveWorkspaceRepository({
        selectedPath,
        repositoryRoots: Object.keys(repositories),
        workspacePath,
        projectRoots: roots.filter((root) => root.status === "available").map((root) => root.path),
      })
    );
  }, [workspacePath, selectedPath, repositories, roots]);
  const scope = useMemo(() => ({ repo: branchRepo }), [branchRepo]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(false);
  const checkoutRequest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; checkoutRequest.current++; };
  }, []);
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
      ? roots.find((root) => root.path === branchRepo)?.label || baseName(branchRepo)
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
  const [checkoutError, setCheckoutError] = useState<{ scope: typeof scope; message: string } | null>(null);
  const branchError = checkoutError?.scope === scope ? checkoutError.message : null;
  /** Dismiss the checkout-error banner (cleared anyway on the next attempt). */
  const dismissBranchError = useCallback(() => setCheckoutError(null), []);
  const handleBranchSelect = useCallback(
    (name: string) => {
      if (!branchRepo) return;
      const request = ++checkoutRequest.current;
      setCheckoutError(null);
      void useGitStore
        .getState()
        .checkout(branchRepo, name)
        .catch((err: unknown) => {
          if (mounted.current && currentScope.current === scope && checkoutRequest.current === request) {
            setCheckoutError({ scope, message: errorText(err) });
          }
        });
    },
    [branchRepo, scope],
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
