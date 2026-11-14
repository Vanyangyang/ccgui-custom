import {
  leaderGroupBranches, parentWorkspacePath, sameIdentity,
  type LeaderBranch, type LeaderIdentity, type LeaderSnapshot,
} from "@/features/leader/types";
import type { SessionMeta } from "@/lib/ipc";
import { CLEANUP_IDLE_RECOMMEND_MS, type SessionCleanupItem } from "./session-cleanup";

type TreeInput = {
  session: SessionMeta;
  sessions: SessionMeta[];
  leaderSnapshot: LeaderSnapshot;
  classifyMember: (member: SessionMeta) => SessionCleanupItem;
  now: number;
};

const identityOf = (session: SessionMeta): LeaderIdentity =>
  ({ engine: session.engine, sessionId: session.sessionId, workspacePath: session.workspacePath });

const branchChat = (branch: LeaderBranch): LeaderIdentity | null => branch.sessionId
  ? { engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath } : null;

/** Mirrors native `cleanup_settled`: a successful finish, or any ending once
 * the parent's lease lapsed. Live or pending work never qualifies. */
export function cleanupSettled(branch: LeaderBranch, now: number): boolean {
  const succeeded = (state: string, error: string | null) => ["completed", "handed_off"].includes(state) && !error;
  const ended = (state: string) => ["completed", "handed_off", "failed", "stopped", "unknown"].includes(state);
  return (!!branch.sessionId && succeeded(branch.state, branch.error)
      && (!branch.delegation || succeeded(branch.delegation.state, branch.delegation.error)))
    || (branch.deadlineAt > 0 && now >= branch.deadlineAt && ended(branch.state)
      && (!branch.delegation || ended(branch.delegation.state)));
}

/** A selectable tree must have complete metadata and no member needing follow-up.
 * `branches` lists every governed branch, starting with a child root's own branch. */
function classifyTree({ session, sessions, leaderSnapshot, classifyMember, now, branches, child }: TreeInput & {
  branches: LeaderBranch[];
  child?: { parent: LeaderIdentity; branchId: string };
}): SessionCleanupItem | null {
  const root = identityOf(session);
  // Chats a nested archive already froze cannot change; native skips them too.
  const frozen = (identity: LeaderIdentity) => (leaderSnapshot.archivedGroups ?? [])
    .some((group) => group.members.some((member) => sameIdentity(member, identity)));
  const members: LeaderIdentity[] = [root];
  const liveMembers = [session];
  const activity: number[] = [];
  const signature: string[] = [];
  for (const branch of branches) {
    if (!cleanupSettled(branch, now)) return null;
    activity.push(branch.updatedAt, branch.lastActivityAt);
    if (branch.delegation) activity.push(branch.delegation.updatedAt);
    signature.push(JSON.stringify([branch.id, branch.parentEngine, branch.parentSessionId,
      parentWorkspacePath(branch), branch.engine, branch.sessionId, branch.workspacePath]));
    const identity = branchChat(branch);
    if (!identity || sameIdentity(identity, root)) continue;
    if (members.some((candidate) => sameIdentity(candidate, identity))) return null;
    members.push(identity);
    if (frozen(identity)) continue;
    const member = sessions.find((candidate) => sameIdentity(candidate, identity));
    if (!member) return null;
    liveMembers.push(member);
  }

  let rootItem: SessionCleanupItem | undefined;
  for (const member of liveMembers) {
    if (member.remote) return null;
    const item = classifyMember(member);
    if (item.category !== "recommend" || item.idleMs === null || member.updatedAt === null) return null;
    if (member === session) rootItem = item;
    activity.push(member.updatedAt);
  }
  if (!rootItem || activity.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const lastActivityAt = activity.reduce((latest, value) => Math.max(latest, value), 0);
  const idleMs = Math.max(0, now - lastActivityAt);
  const isLongIdle = idleMs >= CLEANUP_IDLE_RECOMMEND_MS;
  return {
    ...rootItem,
    reason: child ? (isLongIdle ? "leader_child_idle" : "leader_child_recent") : (isLongIdle ? "leader_group_idle" : "leader_group_recent"),
    idleMs,
    defaultSelected: isLongIdle,
    ...(child ? { managedParent: child.parent } : {}),
    group: {
      root, memberCount: members.length, lastActivityAt, signature: JSON.stringify(signature.sort()),
      expected: { branchIds: branches.map((branch) => branch.id), members, lastActivityAt },
      ...child,
    },
  };
}

/** The topmost root row represents its whole task group. */
export function classifyCleanupGroup(input: TreeInput): SessionCleanupItem | null {
  const { leaderSnapshot } = input;
  const root = identityOf(input.session);
  if (leaderSnapshot.branches.some((branch) => {
    const chat = branch.state !== "reclaimed" ? branchChat(branch) : null;
    return !!chat && sameIdentity(root, chat);
  }) || leaderSnapshot.archivedGroups?.some((group) => sameIdentity(group.root, root))) return null;
  const branches = leaderGroupBranches(leaderSnapshot, root);
  if (!branches.length) return null;
  return classifyTree({ ...input, branches });
}

/** A child row whose lease lapsed represents its own subtree, so it can be
 * archived while the parent conversation stays live. */
export function classifyCleanupSubtree(input: TreeInput): SessionCleanupItem | null {
  const { leaderSnapshot, now } = input;
  const root = identityOf(input.session);
  const owners = leaderSnapshot.branches.filter((branch) => {
    const chat = branch.state !== "reclaimed" ? branchChat(branch) : null;
    return !!chat && sameIdentity(root, chat);
  });
  if (owners.length !== 1) return null;
  const top = owners[0];
  const parent = { engine: top.parentEngine, sessionId: top.parentSessionId, workspacePath: parentWorkspacePath(top) };
  // An archived parent already owns this subtree; the native command refuses it too.
  if (!(top.deadlineAt > 0 && now >= top.deadlineAt) || leaderSnapshot.archivedGroups?.some((group) =>
    sameIdentity(group.root, root) || group.branchIds.includes(top.id)
    || group.members.some((member) => sameIdentity(member, root) || sameIdentity(member, parent)))) return null;
  const descendants = leaderGroupBranches(leaderSnapshot, root);
  return classifyTree({ ...input, branches: [top, ...descendants], child: { parent, branchId: top.id } });
}
