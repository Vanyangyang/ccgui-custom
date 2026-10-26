import { describe, expect, it } from "vitest";
import { isLeaderGroupMember, isDirectChild, leaderGroupRoot, leaderGroupBranches, parentWorkspacePath, type LeaderBranch, type LeaderSnapshot } from "./types";
import { groupLeaderThreads, parentOfBranch } from "./tree";

const parent = { engine: "claude", sessionId: "parent", workspacePath: "G:/project" };
const child = { engine: "codex", sessionId: "child", workspacePath: "G:/project" };
const branch: LeaderBranch = {
  id: "created-child", parentEngine: parent.engine, parentSessionId: parent.sessionId,
  ...child, title: "Task", task: "Implement", model: null, effort: null, runId: null,
  state: "completed", createdAt: 1, updatedAt: 2, lastActivityAt: 2, deadlineAt: 3,
  expired: false, result: "Done", resultTruncated: false, error: null,
};

describe("created task membership", () => {
  it("keeps cross-workspace ancestry separate from child execution identity", () => {
    const cross = { ...branch, parentWorkspacePath: parent.workspacePath, workspacePath: "G:/game" };
    const grand = { ...branch, id: "grand", parentEngine: cross.engine, parentSessionId: cross.sessionId!,
      parentWorkspacePath: cross.workspacePath, sessionId: "grand", workspacePath: "G:/tools" };
    const snapshot = { leaders: [], branches: [cross, grand] };
    expect(isDirectChild(cross, parent)).toBe(true);
    expect(isDirectChild(cross, { ...parent, workspacePath: cross.workspacePath })).toBe(false);
    expect(leaderGroupRoot(snapshot, { engine: grand.engine, sessionId: grand.sessionId, workspacePath: grand.workspacePath })).toEqual(parent);
    expect(leaderGroupBranches(snapshot, parent).map(b => b.id)).toEqual([cross.id, grand.id]);
    expect(parentWorkspacePath(branch)).toBe(branch.workspacePath);
    expect(isLeaderGroupMember(snapshot, { ...child, workspacePath: cross.workspacePath })).toBe(true);
    expect(isLeaderGroupMember(snapshot, child)).toBe(false);
    expect(parentOfBranch(cross)).toEqual(parent);
    const grouped = groupLeaderThreads([], snapshot, parent.workspacePath);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ id: "claude/parent", workspacePath: parent.workspacePath,
      children: [{ id: "codex/child", workspacePath: cross.workspacePath,
        children: [{ id: "codex/grand", workspacePath: grand.workspacePath }] }] });
  });
  it("derives parent and child protection from retained branches without a leader flag", () => {
    const snapshot: LeaderSnapshot = { leaders: [], branches: [branch] };
    expect(isLeaderGroupMember(snapshot, parent)).toBe(true);
    expect(isLeaderGroupMember(snapshot, child)).toBe(true);
    expect(isLeaderGroupMember(snapshot, { ...parent, workspacePath: "G:/other" })).toBe(false);
    expect(isLeaderGroupMember(snapshot, { ...child, engine: "agy" })).toBe(false);
    const consulted = { ...child, sessionId: "independent" };
    expect(isLeaderGroupMember(snapshot, consulted)).toBe(false);
    const rows = [parent, child, consulted].map((identity) => ({ id: `${identity.engine}/${identity.sessionId}`, label: identity.sessionId, time: "" }));
    const grouped = groupLeaderThreads(rows, snapshot, parent.workspacePath);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ isLeader: true, protectedFromDeletion: true, children: [{ id: "codex/child", protectedFromDeletion: true }] });
    expect(grouped[1]).toEqual(rows[2]);
  });

  it("ignores legacy mode markers and reclaimed branches", () => {
    const snapshot: LeaderSnapshot = { leaders: [parent], branches: [{ ...branch, state: "reclaimed" }] };
    expect(isLeaderGroupMember(snapshot, parent)).toBe(false);
    expect(isLeaderGroupMember(snapshot, child)).toBe(false);
    const rows = [{ id: "claude/parent", label: "Parent", time: "" }];
    expect(groupLeaderThreads(rows, snapshot, parent.workspacePath)).toBe(rows);
  });

  it("retains archived group membership while branch snapshots are unavailable", () => {
    const snapshot: LeaderSnapshot = { leaders: [], branches: [], archivedGroups: [{
      root: parent, title: "Task group", archivedAt: 4, members: [child], branchIds: [branch.id],
    }] };
    expect(isLeaderGroupMember(snapshot, parent)).toBe(true);
    expect(isLeaderGroupMember(snapshot, child)).toBe(true);
    expect(isLeaderGroupMember(snapshot, { ...child, sessionId: "consulted" })).toBe(false);
  });
});
