import { sameLeaderWorkspace } from "./workspace-path";
import type { PromptCacheWindow } from "@/lib/ipc";

export interface LeaderIdentity {
  engine: string;
  sessionId: string;
  workspacePath: string;
}

export interface GroupCleanupExpectation {
  branchIds: string[];
  members: LeaderIdentity[];
  lastActivityAt: number;
}

export interface LeaderHandoffLink {
  branchId: string;
  requestId: string;
  operationId: string;
  payloadFingerprint: string;
}

/** Native-owned image; filesystem locations must never enter plugin projections. */
export interface TaskImage { source: string; path: string; sha256: string }
export function taskImageRefs(images: TaskImage[] = []): string[] {
  return images.map(image => {
    if (!/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error("Invalid native task image identity");
    return `task-image:${image.sha256}`;
  });
}

export interface LeaderBranch {
  id: string;
  parentEngine: string;
  parentSessionId: string;
  /** Exact parent source; absent in legacy same-workspace records. */
  parentWorkspacePath?: string;
  /** Child execution cwd. */
  workspacePath: string;
  engine: string;
  sessionId: string | null;
  title: string;
  task: string;
  images?: TaskImage[];
  model: string | null;
  effort: string | null;
  /** Explicit handoff channel retained for successor launches and recovery. */
  providerId?: string;
  runId: string | null;
  state: "starting" | "running" | "waiting" | "awaiting_cost_approval" | "completed" | "failed" | "stopped" | "handed_off" | "unknown" | "reclaiming" | "reclaimed";
  handoffTo?: LeaderHandoffLink;
  handoffFrom?: LeaderHandoffLink;
  costApproval?: { requestId: string; capturedAt: number; cache?: PromptCacheWindow | null; model?: string | null; imageRefs?: string[] };
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  deadlineAt: number;
  expired: boolean;
  result: string;
  resultTruncated: boolean;
  error: string | null;
  /** Latest parent assignment; later manual child turns do not reopen its terminal state. */
  delegation?: TaskDelegation;
}

export interface TaskDelegation {
  requestId: string;
  runId: string | null;
  task: string;
  images?: TaskImage[];
  state: LeaderBranch["state"];
  createdAt: number;
  updatedAt: number;
  result: string;
  resultTruncated: boolean;
  error: string | null;
  costApproval?: LeaderBranch["costApproval"];
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
    && sameLeaderWorkspace(parentWorkspacePath(branch), parent.workspacePath);
}

export function parentWorkspacePath(branch: LeaderBranch): string {
  return branch.parentWorkspacePath ?? branch.workspacePath;
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

/** A record rooted at a managed child chat archives only that child's subtree;
 * its own branch is implied by the chat identity rather than listed. */
export function archivedChildBranch(snapshot: LeaderSnapshot, group: LeaderArchivedGroup): LeaderBranch | undefined {
  return snapshot.branches.find((branch) => branch.state !== "reclaimed" && branch.sessionId !== null && sameIdentity({
    engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath,
  }, group.root));
}

/** Every branch a record governs, including a child-rooted record's own branch. */
export function archivedGroupBranches(snapshot: LeaderSnapshot, group: LeaderArchivedGroup): LeaderBranch[] {
  const top = archivedChildBranch(snapshot, group);
  return snapshot.branches.filter((branch) => branch === top || group.branchIds.includes(branch.id));
}

export function archivedBranchIds(snapshot: LeaderSnapshot): Set<string> {
  return new Set((snapshot.archivedGroups ?? []).flatMap((group) => archivedGroupBranches(snapshot, group).map((branch) => branch.id)));
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
    root = { engine: branch.parentEngine, sessionId: branch.parentSessionId, workspacePath: parentWorkspacePath(branch) };
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
