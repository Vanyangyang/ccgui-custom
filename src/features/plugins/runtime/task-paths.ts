/**
 * Write-scope arithmetic for host tasks. Paths compare by directory segment
 * (never string prefix); Windows drive paths ignore case and separator style.
 * A scope of `null` means the whole workspace (undeclared writes); `[]` is a
 * read-only task and never conflicts.
 */

export function taskPathKey(path: string): string {
  const unified = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/** Same directory, or one strictly inside the other. */
export function taskPathsOverlap(a: string, b: string): boolean {
  const x = taskPathKey(a);
  const y = taskPathKey(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function sameTaskPath(a: string, b: string): boolean {
  return taskPathKey(a) === taskPathKey(b);
}

/** Normalize declared write paths relative to their workspace. Absolute paths
 * must stay inside it and `..` never escapes. Returns null for "whole workspace". */
export function normalizeTaskWritePaths(paths: readonly string[] | undefined, workspacePath: string): string[] | null {
  if (paths === undefined) return null;
  if (!Array.isArray(paths) || paths.length > 64) throw new Error("writePaths must be an array of at most 64 paths");
  const root = taskPathKey(workspacePath);
  const rootRaw = workspacePath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const result: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) {
      throw new Error("writePaths entries must be non-empty single-line paths");
    }
    let unified = raw.trim().replace(/\\/g, "/");
    if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
      const key = taskPathKey(unified);
      if (key === root) unified = "";
      else if (key.startsWith(`${root}/`)) unified = unified.replace(/\/+$/, "").slice(rootRaw.length + 1);
      else throw new Error(`writePaths entry ${JSON.stringify(raw)} is outside the execution workspace`);
    }
    const parts: string[] = [];
    for (const segment of unified.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") throw new Error(`writePaths entry ${JSON.stringify(raw)} escapes the execution workspace`);
      parts.push(segment);
    }
    if (!parts.length) return null; // "." claims the whole workspace.
    const normalized = parts.join("/");
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

export interface TaskWriteScope {
  workspacePath: string;
  /** null = whole workspace; [] = read-only. */
  writePaths: readonly string[] | null;
}

function absoluteScopes(scope: TaskWriteScope): string[] {
  if (scope.writePaths === null) return [scope.workspacePath];
  const root = scope.workspacePath.replace(/[\\/]+$/, "");
  return scope.writePaths.map((path) => `${root}/${path}`);
}

/** Two tasks conflict when their declared (or unknown) writes can touch the same file. */
export function taskScopesConflict(a: TaskWriteScope, b: TaskWriteScope): boolean {
  if (!taskPathsOverlap(a.workspacePath, b.workspacePath)) return false;
  if (a.writePaths?.length === 0 || b.writePaths?.length === 0) return false;
  const left = absoluteScopes(a);
  const right = absoluteScopes(b);
  return left.some((x) => right.some((y) => taskPathsOverlap(x, y)));
}
