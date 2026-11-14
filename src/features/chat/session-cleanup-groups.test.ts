import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/ipc";
import type { LeaderBranch, LeaderSnapshot } from "@/features/leader/types";
import { classifySessionForCleanup, CLEANUP_IDLE_RECOMMEND_MS } from "./session-cleanup";
import { classifyCleanupGroup, classifyCleanupSubtree } from "./session-cleanup-groups";

const NOW = 1_900_000_000_000;
const HOUR = 60 * 60 * 1000;

function session(sessionId: string, workspacePath: string, updatedAt = NOW - 48 * HOUR): SessionMeta {
  return {
    engine: "codex", sessionId, workspacePath, filePath: "", fileSize: 0, fileMtimeMs: 0,
    title: sessionId, preview: "", createdAt: updatedAt, updatedAt, messageCount: 1,
    pinned: false, customTitle: null,
  };
}

function branch(parent: SessionMeta, child: SessionMeta, overrides: Partial<LeaderBranch> = {}): LeaderBranch {
  return {
    id: `branch-${child.sessionId}`, parentEngine: parent.engine, parentSessionId: parent.sessionId,
    parentWorkspacePath: parent.workspacePath, workspacePath: child.workspacePath,
    engine: child.engine, sessionId: child.sessionId, title: child.title, task: "work", model: null,
    effort: null, runId: null, state: "completed", createdAt: NOW - 48 * HOUR,
    updatedAt: NOW - 48 * HOUR, lastActivityAt: NOW - 48 * HOUR, deadlineAt: NOW,
    expired: false, result: "done", resultTruncated: false, error: null, ...overrides,
  };
}

function classify(root: SessionMeta, sessions: SessionMeta[], snapshot: LeaderSnapshot, now = NOW) {
  return classifyCleanupGroup({
    session: root, sessions, leaderSnapshot: snapshot, now,
    classifyMember: (member) => classifySessionForCleanup({ session: member, now }),
  });
}

function classifyChild(child: SessionMeta, sessions: SessionMeta[], snapshot: LeaderSnapshot, now = NOW) {
  return classifyCleanupSubtree({
    session: child, sessions, leaderSnapshot: snapshot, now,
    classifyMember: (member) => classifySessionForCleanup({ session: member, now }),
  });
}

const identity = (session: SessionMeta) => ({ engine: session.engine, sessionId: session.sessionId, workspacePath: session.workspacePath });

describe("task group cleanup", () => {
  it("uses the latest activity across the complete cross-workspace tree", () => {
    const root = session("root", "/root");
    const child = session("child", "/other");
    const grandchild = session("grandchild", "/other", NOW - 2 * HOUR);
    const snapshot = { leaders: [], branches: [branch(root, child), branch(child, grandchild, { lastActivityAt: NOW - 3 * HOUR })] };
    const recent = classify(root, [root, child, grandchild], snapshot)!;
    expect(recent.reason).toBe("leader_group_recent");
    expect(recent.defaultSelected).toBe(false);
    expect(recent.group?.memberCount).toBe(3);
    expect(recent.group?.lastActivityAt).toBe(grandchild.updatedAt);
    const idle = classify(root, [root, child, grandchild], snapshot, NOW + 10 * HOUR)!;
    expect(idle.reason).toBe("leader_group_idle");
    expect(idle.defaultSelected).toBe(true);
    expect(idle.idleMs).toBe(CLEANUP_IDLE_RECOMMEND_MS);
    expect(classify(child, [root, child, grandchild], snapshot)).toBeNull();
  });

  it.each(["starting", "running", "waiting", "awaiting_cost_approval", "failed", "stopped", "unknown", "reclaiming"] as const)(
    "does not recommend a group with a %s child whose lease is live", (state) => {
      const root = session("root", "/root"), child = session("child", "/root");
      expect(classify(root, [root, child], { leaders: [], branches: [branch(root, child, { state, deadlineAt: NOW + HOUR })] })).toBeNull();
    },
  );

  it.each(["failed", "stopped", "unknown"] as const)("settles a %s child once its lease lapsed", (state) => {
    const root = session("root", "/root"), child = session("child", "/root");
    const failed = branch(root, child, { state, error: "quota reached", deadlineAt: NOW - HOUR });
    expect(classify(root, [root, child], { leaders: [], branches: [failed] })?.reason).toBe("leader_group_idle");
    // A launch that never produced a chat is history too, once its lease lapsed.
    const unbound = { ...failed, id: "branch-unbound", sessionId: null };
    expect(classify(root, [root, child], { leaders: [], branches: [failed, unbound] })?.group?.expected.branchIds)
      .toEqual(["branch-child", "branch-unbound"]);
    expect(classify(root, [root, child], { leaders: [], branches: [failed, { ...unbound, deadlineAt: NOW + HOUR }] })).toBeNull();
  });

  it.each(["starting", "running", "waiting", "awaiting_cost_approval", "reclaiming"] as const)(
    "never settles live %s work after its lease lapsed", (state) => {
      const root = session("root", "/root"), child = session("child", "/root");
      expect(classify(root, [root, child], { leaders: [], branches: [branch(root, child, { state, deadlineAt: NOW - HOUR })] })).toBeNull();
    },
  );

  it("keeps incomplete, remote, unknown-activity, pinned and attention members protected", () => {
    const root = session("root", "/root"), child = session("child", "/root");
    const snapshot = { leaders: [], branches: [branch(root, child)] };
    expect(classify(root, [root], snapshot)).toBeNull();
    expect(classify(root, [root, { ...child, remote: true }], snapshot)).toBeNull();
    expect(classify(root, [root, { ...child, updatedAt: null }], snapshot)).toBeNull();
    expect(classify(root, [root, { ...child, pinned: true }], snapshot)).toBeNull();
    expect(classify(root, [root, child], { leaders: [], branches: [branch(root, child, { lastActivityAt: 0 })] })).toBeNull();
    expect(classifyCleanupGroup({
      session: root, sessions: [root, child], leaderSnapshot: snapshot, now: NOW,
      classifyMember: (member) => classifySessionForCleanup({ session: member, draftText: member === child ? "draft" : undefined, now: NOW }),
    })).toBeNull();
  });

  it("counts the latest delegation activity and protects an unsuccessful delegation", () => {
    const root = session("root", "/root"), child = session("child", "/root");
    const delegation = {
      requestId: "request", runId: "run", task: "work", state: "completed" as const,
      createdAt: NOW - 48 * HOUR, updatedAt: NOW - HOUR, result: "done", resultTruncated: false, error: null,
    };
    const snapshot = { leaders: [], branches: [branch(root, child, { delegation })] };
    expect(classify(root, [root, child], snapshot)?.group?.lastActivityAt).toBe(NOW - HOUR);
    expect(classify(root, [root, child], snapshot)?.reason).toBe("leader_group_recent");
    const live = { deadlineAt: NOW + HOUR };
    expect(classify(root, [root, child], {
      leaders: [], branches: [branch(root, child, { ...live, delegation: { ...delegation, state: "failed" } })],
    })).toBeNull();
    expect(classify(root, [root, child], {
      leaders: [], branches: [branch(root, child, { ...live, delegation: { ...delegation, error: "unreviewed failure" } })],
    })).toBeNull();
    // Once the lease lapsed, an unsuccessful delegation is history; a live one never is.
    expect(classify(root, [root, child], {
      leaders: [], branches: [branch(root, child, { delegation: { ...delegation, state: "failed" } })],
    })?.reason).toBe("leader_group_recent");
    expect(classify(root, [root, child], {
      leaders: [], branches: [branch(root, child, { delegation: { ...delegation, state: "running" } })],
    })).toBeNull();
  });

  it("offers an expired child subtree on its own while the parent stays live", () => {
    const root = session("root", "/root", NOW - 5 * 60 * 1000);
    const child = session("child", "/other"), grandchild = session("grandchild", "/other", NOW - 3 * HOUR);
    const snapshot = { leaders: [], branches: [branch(root, child), branch(child, grandchild, { deadlineAt: NOW + HOUR })] };
    const item = classifyChild(child, [root, child, grandchild], snapshot)!;
    expect(item.reason).toBe("leader_child_recent");
    expect(item.selectable).toBe(true);
    expect(item.managedParent).toEqual(identity(root));
    expect(item.group).toMatchObject({
      root: identity(child), parent: identity(root), branchId: "branch-child", memberCount: 2,
      lastActivityAt: grandchild.updatedAt,
      expected: { branchIds: ["branch-child", "branch-grandchild"], members: [identity(child), identity(grandchild)] },
    });
    expect(classifyChild(child, [root, child, grandchild], snapshot, NOW + 10 * HOUR)?.reason).toBe("leader_child_idle");
    // The grandchild's own lease is live, so it is not offered separately.
    expect(classifyChild(grandchild, [root, child, grandchild], snapshot)).toBeNull();
    expect(classifyChild(root, [root, child, grandchild], snapshot)).toBeNull();
  });

  it("keeps live, attention, archived-parent and running-descendant children protected", () => {
    const root = session("root", "/root"), child = session("child", "/root"), grandchild = session("grandchild", "/root");
    const sessions = [root, child, grandchild];
    const live = { leaders: [], branches: [branch(root, child, { deadlineAt: NOW + HOUR })] };
    expect(classifyChild(child, sessions, live)).toBeNull();
    const running = { leaders: [], branches: [branch(root, child), branch(child, grandchild, { state: "running" as const })] };
    expect(classifyChild(child, sessions, running)).toBeNull();
    const archivedParent = { leaders: [], branches: [branch(root, child)], archivedGroups: [{
      root: identity(root), title: "Root", archivedAt: 1, members: [identity(root), identity(child)], branchIds: ["branch-child"],
    }] };
    expect(classifyChild(child, sessions, archivedParent)).toBeNull();
    expect(classifyCleanupSubtree({
      session: child, sessions, leaderSnapshot: { leaders: [], branches: [branch(root, child)] }, now: NOW,
      classifyMember: (member) => classifySessionForCleanup({ session: member, unseen: member === child, now: NOW }),
    })).toBeNull();
  });

  it("includes a separately archived child in its group without requiring its chat row", () => {
    const root = session("root", "/root"), child = session("child", "/root"), sibling = session("sibling", "/root", NOW - 30 * HOUR);
    const snapshot = { leaders: [], branches: [branch(root, child), branch(root, sibling)], archivedGroups: [{
      root: identity(child), title: "Child", archivedAt: 1, members: [identity(child)], branchIds: [],
    }] };
    const item = classify(root, [root, sibling], snapshot)!;
    expect(item.group?.expected).toMatchObject({
      branchIds: ["branch-child", "branch-sibling"], members: [identity(root), identity(child), identity(sibling)],
    });
    expect(item.group?.memberCount).toBe(3);
    expect(classify(root, [root, sibling], { ...snapshot, archivedGroups: [] })).toBeNull();
  });
});
