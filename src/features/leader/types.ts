import { sameLeaderWorkspace } from "./workspace-path";

export interface LeaderIdentity {
  engine: string;
  sessionId: string;
  workspacePath: string;
}

export interface LeaderBranch {
  id: string;
  parentEngine: string;
  parentSessionId: string;
  workspacePath: string;
  engine: string;
  sessionId: string | null;
  title: string;
  task: string;
  model: string | null;
  effort: string | null;
  runId: string | null;
  state: "starting" | "running" | "waiting" | "completed" | "failed" | "stopped" | "unknown" | "reclaiming" | "reclaimed";
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  deadlineAt: number;
  expired: boolean;
  result: string;
  resultTruncated: boolean;
  error: string | null;
}

export interface LeaderArchivedGroup {
  root: LeaderIdentity;
  title: string;
  archivedAt: number;
  members: LeaderIdentity[];
  branchIds: string[];
  deletionStarted?: boolean;
}

export interface LeaderSnapshot {
  leaders: LeaderIdentity[];
  branches: LeaderBranch[];
  archivedGroups?: LeaderArchivedGroup[];
}

export function isDirectChild(branch: LeaderBranch, parent: LeaderIdentity) {
  return branch.parentEngine === parent.engine && branch.parentSessionId === parent.sessionId
    && sameLeaderWorkspace(branch.workspacePath, parent.workspacePath);
}

export function sameIdentity(a: LeaderIdentity, b: LeaderIdentity) {
  return a.engine === b.engine && a.sessionId === b.sessionId && sameLeaderWorkspace(a.workspacePath, b.workspacePath);
}

/** Managed membership comes from created branches or retained archive records,
 * never the compatibility list of formerly enabled leaders. */
export function isLeaderGroupMember(snapshot: LeaderSnapshot, identity: LeaderIdentity): boolean {
  return snapshot.branches.some((branch) => branch.state !== "reclaimed" &&
    (isDirectChild(branch, identity) || (branch.sessionId !== null && sameIdentity({
      engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath,
    }, identity)))) || !!snapshot.archivedGroups?.some((group) =>
      sameIdentity(group.root, identity) || group.members.some((member) => sameIdentity(member, identity)));
}

export function leaderGroupRoot(snapshot: LeaderSnapshot, identity: LeaderIdentity): LeaderIdentity {
  let root = identity;
  const seen = new Set<string>();
  while (true) {
    const key = JSON.stringify(root);
    if (seen.has(key)) return root;
    seen.add(key);
    const branch = snapshot.branches.find((b) => b.state !== "reclaimed" && b.sessionId === root.sessionId && b.engine === root.engine && sameLeaderWorkspace(b.workspacePath, root.workspacePath));
    if (!branch) return root;
    root = { engine: branch.parentEngine, sessionId: branch.parentSessionId, workspacePath: branch.workspacePath };
  }
}

export function leaderGroupBranches(snapshot: LeaderSnapshot, root: LeaderIdentity): LeaderBranch[] {
  const parents = [root];
  const result: LeaderBranch[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < parents.length; index++) {
    for (const branch of snapshot.branches) {
      if (branch.state === "reclaimed" || seen.has(branch.id) || !isDirectChild(branch, parents[index])) continue;
      seen.add(branch.id); result.push(branch);
      if (branch.sessionId) parents.push({ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath });
    }
  }
  return result;
}

export function leaderBranchSubtree(snapshot: LeaderSnapshot, branchId: string): LeaderBranch[] {
  const branch = snapshot.branches.find((b) => b.id === branchId && b.state !== "reclaimed");
  if (!branch) return [];
  const descendants = branch.sessionId ? leaderGroupBranches(snapshot, {
    engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath,
  }) : [];
  return [branch, ...descendants.filter((b) => b.id !== branch.id)];
}
