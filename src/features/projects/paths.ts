import type { ProjectRoot, WorkspaceProject } from "./types";
/** Lexical identity only; native validation remains responsible for symlinks and scope. */
export function normalizeProjectPath(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const windows = /^[a-z]:/i.test(slash) || slash.startsWith("//");
  const prefix = slash.startsWith("//") ? "//" : slash.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of slash.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && !parts.at(-1)?.endsWith(":")) parts.pop();
    else if (part !== "..") parts.push(part);
  }
  const result = prefix + parts.join("/");
  return windows ? result.toLowerCase() : result;
}
export function projectPathContains(root: string, path: string): boolean {
  const a = normalizeProjectPath(root), b = normalizeProjectPath(path);
  return !!a && (a === b || b.startsWith(a.endsWith("/") ? a : `${a}/`));
}
export function projectContainsPath(project: WorkspaceProject, path: string): boolean {
  return project.members.some((member) => projectPathContains(member.path, path));
}
export function projectForPath(projects: WorkspaceProject[], path: string, preferredId?: string | null): WorkspaceProject | null {
  const preferred = projects.find((p) => p.id === preferredId && projectContainsPath(p, path));
  if (preferred) return preferred;
  const candidates = projects.map((project) => ({ project, depth: Math.max(-1, ...project.members.filter((m) => projectPathContains(m.path, path)).map((m) => normalizeProjectPath(m.path).split("/").length)) })).filter((p) => p.depth >= 0);
  const depth = Math.max(-1, ...candidates.map((p) => p.depth));
  const best = candidates.filter((p) => p.depth === depth);
  return best.length === 1 ? best[0].project : null;
}
export function projectRoots(project: WorkspaceProject): ProjectRoot[] {
  return project.members.filter((member, index, all) => !all.some((other, otherIndex) => {
    if (index === otherIndex || !projectPathContains(other.path, member.path)) return false;
    const same = normalizeProjectPath(other.path) === normalizeProjectPath(member.path);
    // Retain unavailable entries for status display. They are not index roots;
    // consumers skip them rather than concealing their offline/changed state.
    if (!same && (other.status !== "available" || member.status !== "available")) return false;
    return !same || otherIndex < index;
  }));
}
