/**
 * Resolve WHICH Git repository the status-bar branch chip should track for a
 * file-tree selection.
 *
 * A workspace root may itself be a plain folder whose children are individual
 * repositories (a scratch/monorepo parent), and a selection can be any folder
 * or file inside one of them. Git IPC commands accept any path inside a
 * worktree, so once we know the repository root the whole git store just
 * re-keys on that path. We walk upward from the selected node and return the
 * deepest known repository root containing it, stopping at the workspace
 * boundary — ties at the boundary stay with the workspace status path.
 *
 * The walk starts at the selected path ITSELF: the tree's `selectPath` does
 * not record whether the node is a file or a directory (its `isDir` argument
 * is never passed by the tree), and a file path never equals a directory root
 * key, so testing the path itself is both correct and isDir-agnostic.
 */

/** Separator- and (Windows-only) case-insensitive key. Drive-letter paths
 * arrive from the picker with mixed `\`/`/` separators and inconsistent
 * drive-letter case; POSIX paths stay case-sensitive. */
function normalize(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

/** True when `pathOrDir` is `dir` itself or lives inside it. */
export function isWithinDirectory(dir: string, pathOrDir: string): boolean {
  const d = normalize(dir);
  const p = normalize(pathOrDir);
  return p === d || p.startsWith(d + "/");
}

/** Directory containing `path` (identity when already at a drive root). */
function parentDirectory(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

export interface RepositorySelectionInput {
  /** Selected tree node path (file or directory), or null. */
  selectedPath: string | null;
  /** Repository root paths (file store `repositories` keys). */
  repositoryRoots: readonly string[];
  /** Active workspace path — the outer boundary of the walk. */
  workspacePath: string;
}

/**
 * Deepest repository root containing the selection, verbatim from
 * `repositoryRoots` (so it can be used as an IPC key). Null when nothing is
 * selected, the selection lies outside the workspace (stale tree state from
 * another workspace), or the deepest hit is the workspace root itself — the
 * workspace-root case is what the default workspace status already shows.
 */
export function resolveSelectedRepository(
  input: RepositorySelectionInput,
): string | null {
  const { selectedPath, repositoryRoots, workspacePath } = input;
  if (!selectedPath) return null;
  // Guard against stale tree state: the files store keeps the previous
  // workspace's selection until its panel re-mounts.
  if (!isWithinDirectory(workspacePath, selectedPath)) return null;
  const roots: Record<string, string> = {};
  for (const p of repositoryRoots) roots[normalize(p)] = p;
  let candidate = selectedPath;
  let previous = "";
  while (isWithinDirectory(workspacePath, candidate)) {
    if (candidate !== previous) {
      const hit = roots[normalize(candidate)];
      if (hit && !isWithinDirectory(hit, workspacePath)) return hit;
      previous = candidate;
    }
    const next = parentDirectory(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return null;
}

/** Resolve the Git path used by a workspace-scoped surface. */
export function resolveWorkspaceRepository(input: RepositorySelectionInput): string {
  return resolveSelectedRepository(input) ?? input.workspacePath;
}
