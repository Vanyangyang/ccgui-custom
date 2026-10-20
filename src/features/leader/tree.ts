import type { AiChatThread } from "@/components/application/ai-chat/sidebar-types";
import type { LeaderBranch, LeaderSnapshot } from "./types";
import { sameLeaderWorkspace } from "./workspace-path";

export function groupLeaderThreads(threads: AiChatThread[], snapshot: LeaderSnapshot, workspacePath: string): AiChatThread[] {
  const archived = (snapshot.archivedGroups ?? []).filter((g) => sameLeaderWorkspace(g.root.workspacePath, workspacePath));
  const hiddenIds = new Set(archived.flatMap((g) => [g.root, ...g.members].map((m) => `${m.engine}/${m.sessionId}`)));
  const hiddenBranches = new Set(archived.flatMap((g) => g.branchIds));
  const branches = snapshot.branches.filter((b) => sameLeaderWorkspace(b.workspacePath, workspacePath) && b.state !== "reclaimed" && !hiddenBranches.has(b.id)
    && !hiddenIds.has(`${b.parentEngine}/${b.parentSessionId}`) && (!b.sessionId || !hiddenIds.has(`${b.engine}/${b.sessionId}`)));
  if (!archived.length && !branches.length) return threads;
  const rows = new Map(threads.filter((t) => t.id && !hiddenIds.has(t.id) && !hiddenBranches.has(t.id.replace(/^leader-branch:/, ""))).map((t) => [t.id!, { ...t }]));
  const childIds = new Set<string>();
  for (const branch of branches) {
    const id = branch.sessionId ? `${branch.engine}/${branch.sessionId}` : `leader-branch:${branch.id}`;
    childIds.add(id);
    const row = rows.get(id) ?? { id, label: branch.title, engine: branch.engine, workspacePath: branch.workspacePath, time: "" };
    rows.set(id, { ...row, workspacePath: row.workspacePath ?? branch.workspacePath, label: row.label || branch.title, leaderBranch: branch, protectedFromDeletion: true, selectable: !!branch.sessionId });
    const parentId = `${branch.parentEngine}/${branch.parentSessionId}`;
    if (!rows.has(parentId)) rows.set(parentId, { id: parentId, label: branch.parentSessionId.slice(0, 8), engine: branch.parentEngine, workspacePath: branch.workspacePath, time: "", leaderParentFallback: true });
  }
  for (const branch of branches) {
    const id = branch.sessionId ? `${branch.engine}/${branch.sessionId}` : `leader-branch:${branch.id}`;
    const parent = rows.get(`${branch.parentEngine}/${branch.parentSessionId}`)!;
    parent.workspacePath ??= branch.workspacePath;
    parent.isLeader = true;
    parent.protectedFromDeletion = true;
    (parent.children ??= []).push(rows.get(id)!);
  }
  // Backend prohibits ancestry cycles; guard rendering against malformed data.
  const visited = new Set<string>();
  const prune = (row: AiChatThread): AiChatThread | null => {
    if (row.id && visited.has(row.id)) return null;
    if (row.id) visited.add(row.id);
    if (row.children) row.children = row.children.map(prune).filter((t): t is AiChatThread => !!t);
    return row;
  };
  const roots = [...rows.values()].filter((row) => !row.id || !childIds.has(row.id)).map(prune).filter((t): t is AiChatThread => !!t);
  for (const row of rows.values()) if (row.id && !visited.has(row.id)) { const fallback = prune(row); if (fallback) roots.push(fallback); }
  return roots;
}

export function threadContains(row: AiChatThread, id: string): boolean {
  return row.id === id || !!row.children?.some((child) => threadContains(child, id));
}

export function flattenLeaderThreads(rows: AiChatThread[]): AiChatThread[] {
  return rows.flatMap((row) => [row, ...flattenLeaderThreads(row.children ?? [])]);
}

export function parentOfBranch(branch: LeaderBranch) {
  return { engine: branch.parentEngine, sessionId: branch.parentSessionId, workspacePath: branch.workspacePath };
}
