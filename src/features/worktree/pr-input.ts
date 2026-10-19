/** Pure helpers for the worktree create dialog: PR input parsing, branch
 *  naming, base ref choice, and default directory layout. No IPC — fully
 *  unit-tested. */
import type { BranchInfo } from "@/lib/ipc";

/** Accepts "1842", "#1842", or a GitHub PR URL (any suffix after the number).
 *  Mirrors the backend's parse_pr_input so the dialog can validate before
 *  the resolve round-trip. */
export function parsePrInput(input: string): number | null {
  const t = input.trim();
  const bare = t.startsWith("#") ? t.slice(1) : t;
  if (/^\d+$/.test(bare)) {
    const n = Number(bare);
    return n > 0 ? n : null;
  }
  const idx = t.indexOf("/pull/");
  if (idx < 0) return null;
  const digits = t
    .slice(idx + "/pull/".length)
    .match(/^\d+/)?.[0];
  if (!digits) return null;
  const n = Number(digits);
  return n > 0 ? n : null;
}

/** kebab-case slug from the first ASCII words of a PR title; "" when the
 *  title has no ASCII content (branch falls back to bare pr-N). */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
}

export function suggestPrBranch(prNumber: number, prTitle?: string | null): string {
  const slug = prTitle ? slugifyTitle(prTitle) : "";
  return slug ? `pr-${prNumber}-${slug}` : `pr-${prNumber}`;
}
/** Frontend sanity check matching git check-ref-format's common failures; the
 *  backend remains the final gate (it emits invalid_branch). */
export function isPlausibleBranchName(name: string): boolean {
  return (
    name !== "" &&
    !/[\s~^:?*[\\]/.test(name) &&
    !name.includes("..") &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock")
  );
}

/** Branch names with "/" (feature/x) would nest the target directory;
 *  flatten for the on-disk layout. */
export function sanitizeDirName(name: string): string {
  return name.replace(/[\\/]+/g, "-").replace(/^\.+/, "").trim();
}

export function parentDirOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  // Keep the root ("/" or "C:\") instead of producing an empty parent.
  return idx > 0 ? trimmed.slice(0, idx) : trimmed.slice(0, Math.max(idx, 0) + 1);
}

export function dirNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(idx + 1);
}

export function joinPath(base: string, child: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sep + child;
}

/** Default base for the new-branch tab: the workspace's own branch — you
 *  branch off the work at hand, which is also what a bare `git worktree add
 *  -b` does (HEAD). main/master are the exception: a local main may lag the
 *  remote, so the remote-tracking sibling wins there (the backend fetches it
 *  before creating, see git_worktree.rs). `current` is the live status branch
 *  ("HEAD" when detached), never a remote-tracking name. */
export function defaultBaseRef(
  branches: BranchInfo[],
  current: string | null | undefined,
): string | null {
  if (branches.length === 0) return null;
  const names = new Set(branches.map((b) => b.name));
  if (current && current !== "main" && current !== "master" && names.has(current)) {
    return current;
  }
  const preferred = ["origin/main", "origin/master", "main", "master"].find((n) =>
    names.has(n),
  );
  return preferred ?? branches.find((b) => b.isRemote)?.name ?? branches[0].name;
}

/** Default layout: sibling `<repo>-worktrees/<branch>` next to the main
 *  checkout (confirmed design decision #6). */
export function defaultWorktreePath(repoPath: string, branch: string): string {
  const root = joinPath(parentDirOf(repoPath), `${dirNameOf(repoPath)}-worktrees`);
  return joinPath(root, sanitizeDirName(branch));
}
