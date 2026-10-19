import { resolveFilePath } from "@/lib/fileLinks";
import { ipc, type FileIndexEntry } from "@/lib/ipc";
import { fileName, joinPath, parentPath } from "@/features/files/store";

/**
 * Canonical form for comparing two paths: forward slashes (Windows accepts
 * either), no trailing separator, lower case (Windows filesystems ignore
 * case). Used at the compare sites below — never for paths handed back to
 * the caller.
 */
function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isUnder(path: string, root: string): boolean {
  const base = pathKey(root);
  const target = pathKey(path);
  return base.length > 0 && (target === base || target.startsWith(`${base}/`));
}

/** Cheap existence probe: the candidate's parent listing contains its name
 *  (case-insensitive — Windows filesystems ignore case). */
async function existsInParent(candidate: string): Promise<boolean> {
  const parent = parentPath(candidate);
  const name = fileName(candidate);
  if (!parent || !name || parent === candidate) return false;
  try {
    const entries = await ipc.listDir(parent);
    const wanted = name.toLowerCase();
    return entries.some((entry) => entry.name.toLowerCase() === wanted);
  } catch {
    return false;
  }
}
/** Existence probe shared with the terminal's path-link provider. Callers
 *  MUST only pass paths under a registered workspace — outside paths reject
 *  through withGrantRetry, which would surface a grant dialog. */
export function pathExistsOnDisk(candidate: string): Promise<boolean> {
  return existsInParent(candidate);
}

/** True when `path` equals or sits below `root` (canonical compare — the
 *  terminal link provider gates its existence probes on this). */
export function isPathUnder(path: string, root: string): boolean {
  return isUnder(path, root);
}

/**
 * `release/app.exe` must not silently bind to `dist/app.exe`: only an
 * unambiguous suffix match counts.
 */
function matchBySuffix(entries: FileIndexEntry[], key: string): FileIndexEntry | null {
  const wanted = key.toLowerCase();
  const matches = entries.filter((entry) => {
    const rel = pathKey(entry.rel);
    return rel === wanted || rel.endsWith(`/${wanted}`);
  });
  return matches.length === 1 ? matches[0] : null;
}

async function findByIndex(root: string, rel: string): Promise<string | null> {
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  // Longest suffix first; a bare basename only as the last resort, and only
  // when it is unambiguous (matchBySuffix enforces that).
  const keys = segments.length > 1 ? [rel, segments[segments.length - 1]] : [rel];
  let entries: FileIndexEntry[];
  try {
    // Build outputs (`release/`, `dist/`) are gitignored in most repos — the
    // normal index cannot see them, so ask for the ignored files too.
    entries = await ipc.listFileIndex(root, true);
  } catch {
    return null;
  }
  for (const key of keys) {
    const match = matchBySuffix(entries, key);
    if (match) return joinPath(root, match.rel);
  }
  return null;
}

/**
 * Resolve a chat file-link to the path actually on disk.
 *
 * `resolveFilePath` (sync) anchors a relative link at the session's workspace
 * and passes absolute links through. That misses the very common layout where
 * the workspace root is the *outer* folder and the project sits nested inside
 * it: a message's `release/app.exe` then resolves to `…/release/app.exe`,
 * which does not exist — both “打开文件” and “打开所在位置” fail with a
 * not-found error even though the file is right there below the root.
 *
 * Two fallbacks, both scoped to candidates inside the workspace (paths
 * elsewhere keep the previous behaviour — probing them would trigger the
 * grant flow on click):
 *  1. list the candidate's parent and keep the candidate when its name shows
 *     up (the branch normal links always take);
 *  2. otherwise suffix-match the link against the workspace file index (the
 *     @-mention index), longest unambiguous suffix first.
 *
 * Returns the sync candidate when nothing better is found, so the caller's
 * existing not-found UX is unchanged. Null means “not a file path at all”
 * (`~/`, `../`, empty).
 */
export async function resolveChatFileLink(
  rawPath: string,
  workspacePath: string,
): Promise<string | null> {
  const candidate = resolveFilePath(rawPath, workspacePath);
  if (!candidate) return null;
  const root = workspacePath.trim();
  if (!root || !isUnder(candidate, root)) return candidate;
  if (await existsInParent(candidate)) return candidate;
  const trimmedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = candidate.replace(/\\/g, "/").slice(trimmedRoot.length).replace(/^\/+/, "");
  return (await findByIndex(root, rel)) ?? candidate;
}
