import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/store";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { invoke } from "@/lib/transport";
import { emitLeaderStreamDelta } from "./event-state";
import { startLeaderRuntime, syncLeaderBranchComms } from "./runtime";
import { useLeaderStore } from "./store";
import type { LeaderBranch, LeaderSnapshot, TaskDelegation } from "./types";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));

const delegation = (patch: Partial<TaskDelegation> = {}): TaskDelegation => ({
  requestId: "assignment-1", runId: "run-1", task: "Original assignment", state: "running",
  createdAt: 10, updatedAt: 20, result: "", resultTruncated: false, error: null, ...patch,
});
const branch = (patch: Partial<LeaderBranch> = {}): LeaderBranch => ({
  id: "delegation-child", parentEngine: "claude", parentSessionId: "parent", workspacePath: "/delegation",
  engine: "codex", sessionId: "child", title: "Child title", task: "Manual continuation",
  model: null, effort: null, runId: "manual-run", state: "running", createdAt: 1, updatedAt: 100,
  lastActivityAt: 100, deadlineAt: 1000, expired: false, result: "Manual result", resultTruncated: false,
  error: null, delegation: delegation(), ...patch,
});
let stop: (() => void) | undefined;
const current = () => useCrossSessionActivityStore.getState().records.find(record => record.scopedId === "leader:delegation-child")!;
function publish(child: LeaderBranch) {
  const snapshot: LeaderSnapshot = { leaders: [], branches: [child] };
  useLeaderStore.setState({ snapshot });
  return snapshot;
}
async function start(child: LeaderBranch) {
  publish(child);
  stop = startLeaderRuntime();
  await Promise.resolve(); await Promise.resolve();
}
beforeEach(() => {
  localStorage.clear();
  useCrossSessionActivityStore.setState({ records: [] });
  useChatStore.setState({ sessions: [], bySession: {} });
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] } });
  vi.mocked(invoke).mockImplementation(async () => useLeaderStore.getState().snapshot);
});
afterEach(() => { stop?.(); stop = undefined; });

describe("communication follows the durable parent delegation", () => {
  it("clears prior image identities when the same child receives a text-only assignment", () => {
    const images = [{ source: "original", path: "G:/private/image.png", sha256: "a".repeat(64) }];
    syncLeaderBranchComms(publish(branch({ delegation: delegation({ images }) })));
    expect(current().imageRefs).toHaveLength(1);
    syncLeaderBranchComms(publish(branch({ delegation: delegation({ requestId: "assignment-2", updatedAt: 21 }) })));
    expect(current().requestId).toBe("assignment-2");
    expect(current().imageRefs).toEqual([]);
    expect(Object.isFrozen(current().imageRefs)).toBe(true);
  });
  it("projects only frozen hashes from the assignment and never exposes native image locations", () => {
    const images = [{ source: "private-source", path: "G:/private/image.png", sha256: "a".repeat(64) }];
    syncLeaderBranchComms(publish(branch({ images: [{ ...images[0], sha256: "b".repeat(64) }], delegation: delegation({ images }) })));
    expect(current().imageRefs).toEqual([`task-image:${"a".repeat(64)}`]);
    expect(Object.isFrozen(current().imageRefs)).toBe(true);
    images[0].sha256 = "c".repeat(64);
    expect(current().imageRefs).toEqual([`task-image:${"a".repeat(64)}`]);
    expect(JSON.stringify(current())).not.toMatch(/private-source|G:\/private/);
  });
  it("keeps navigation participants in their respective workspaces", () => {
    syncLeaderBranchComms(publish(branch({ parentWorkspacePath: "/host", workspacePath: "/game" })));
    expect(current().sender).toMatchObject({ engine: "claude", sessionId: "parent", workspacePath: "/host" });
    expect(current().target).toMatchObject({ engine: "codex", sessionId: "child", workspacePath: "/game" });
  });
  it.each(["manual-run", "run-1-c1"])("keeps completed assignment frozen while child runs %s", async (runId) => {
    const done = delegation({ state: "completed", updatedAt: 30, result: "Original final result", resultTruncated: true });
    await start(branch({ state: "completed", runId: "run-1", delegation: done }));
    publish(branch({ runId, delegation: done }));
    emitLeaderStreamDelta("delegation-child", runId, "unrelated text");
    emitLeaderStreamDelta("delegation-child", "run-1", "late original text");
    expect(current()).toMatchObject({ requestId: "assignment-1", runId: "run-1", status: "completed",
      message: "Original assignment", replyText: "Original final result", truncated: true, acceptedAt: 10, updatedAt: 30 });
  });

  it("keeps approval and guidance active until the delegation completes", async () => {
    const costApproval = { requestId: "approval-1", capturedAt: 15, model: "gpt" };
    await start(branch({ delegation: delegation({ state: "awaiting_cost_approval", costApproval }) }));
    expect(current()).toMatchObject({ status: "awaiting_cost_approval", requestId: "assignment-1", acceptedAt: 10,
      leaderCostApproval: { branchId: "delegation-child", requestId: "approval-1" } });
    publish(branch({ delegation: delegation({ state: "waiting", updatedAt: 21 }) }));
    expect(current().status).toBe("awaiting_permission");
    publish(branch({ delegation: delegation({ state: "running", updatedAt: 22 }) }));
    emitLeaderStreamDelta("delegation-child", "run-1-c1", "Guided reply");
    expect(current()).toMatchObject({ status: "executing", replyText: "Guided reply", updatedAt: 22 });
    publish(branch({ delegation: delegation({ state: "completed", updatedAt: 23, result: "Done with guidance" }) }));
    expect(current()).toMatchObject({ status: "completed", replyText: "Done with guidance" });
    publish(branch({ delegation: delegation({ state: "waiting", updatedAt: 21 }) }));
    expect(current().status).toBe("completed");
  });

  it("marks the old assignment handed off without treating it as a completed result or reopening its cost card", async () => {
    const costApproval = { requestId: "approval-1", capturedAt: 15, model: "gemini" };
    await start(branch({ delegation: delegation({ state: "awaiting_cost_approval", costApproval }) }));
    const handed = delegation({ state: "handed_off", runId: null, updatedAt: 21, costApproval: undefined, result: "" });
    publish(branch({ state: "handed_off", runId: null, delegation: handed }));
    expect(current()).toMatchObject({ status: "handed_off", requestId: "assignment-1" });
    expect(current().leaderCostApproval).toBeUndefined();
    publish(branch({ delegation: delegation({ state: "awaiting_cost_approval", costApproval, updatedAt: 21 }) }));
    expect(current().status).toBe("handed_off");
  });

  it("opens a new task_send assignment and rejects streams and snapshots from the previous one", async () => {
    await start(branch({ delegation: delegation({ state: "completed", updatedAt: 30, result: "Old final" }) }));
    const next = delegation({ requestId: "assignment-2", runId: "run-2", task: "New assignment", createdAt: 40, updatedAt: 41 });
    publish(branch({ delegation: next }));
    expect(current()).toMatchObject({ requestId: "assignment-2", runId: "run-2", status: "executing", message: "New assignment", acceptedAt: 40 });
    expect(current().replyText).toBeUndefined();
    emitLeaderStreamDelta("delegation-child", "run-1", "Old tail");
    emitLeaderStreamDelta("delegation-child", "run-1-c2", "Old continuation");
    expect(current().replyText).toBeUndefined();
    emitLeaderStreamDelta("delegation-child", "run-2", "New reply");
    expect(current().replyText).toBe("New reply");
    publish(branch({ delegation: delegation({ state: "completed", updatedAt: 30, result: "Old final" }) }));
    expect(current()).toMatchObject({ requestId: "assignment-2", replyText: "New reply" });
  });

  it("restores completed delegation from the first snapshot even when the child is running", async () => {
    await start(branch({ delegation: delegation({ state: "completed", updatedAt: 30, result: "Saved final" }) }));
    expect(current()).toMatchObject({ status: "completed", replyText: "Saved final", updatedAt: 30 });
    expect(current().reviewedBy).toHaveLength(2);
  });

  it("preserves the branch-based behavior of legacy snapshots", () => {
    const legacy = branch({ delegation: undefined, runId: "legacy-run", task: "Legacy task", state: "completed", result: "Legacy result" });
    syncLeaderBranchComms(publish(legacy));
    expect(current()).toMatchObject({ requestId: legacy.id, runId: "legacy-run", message: "Legacy task",
      status: "completed", replyText: "Legacy result", updatedAt: 100 });
  });

  it("migrates a newer legacy checkpoint card to an older completed delegation without allowing downgrade", () => {
    const legacy = branch({ delegation: undefined, updatedAt: 100, result: "Manual preview" });
    syncLeaderBranchComms(publish(legacy));
    expect(current()).toMatchObject({ status: "executing", leaderUpdatedAt: 100 });
    expect(current().leaderDelegationId).toBeUndefined();

    const done = branch({ delegation: delegation({ state: "completed", updatedAt: 30, result: "Assignment final" }) });
    syncLeaderBranchComms(publish(done));
    expect(current()).toMatchObject({ status: "completed", replyText: "Assignment final", leaderUpdatedAt: 30,
      leaderDelegationId: "assignment-1", acceptedAt: 10 });

    syncLeaderBranchComms(publish({ ...legacy, updatedAt: 200 }));
    expect(current()).toMatchObject({ status: "completed", replyText: "Assignment final", leaderUpdatedAt: 30,
      leaderDelegationId: "assignment-1" });
  });

  it.each(["completed", "failed", "unknown"] as const)("keeps %s ahead of a late active snapshot in the same millisecond", (terminal) => {
    const done = branch({ delegation: delegation({ state: terminal, updatedAt: 30, result: "Final" }) });
    syncLeaderBranchComms(publish(done));
    for (const state of ["starting", "running", "waiting", "awaiting_cost_approval"] as const) {
      syncLeaderBranchComms(publish(branch({ delegation: delegation({ state, updatedAt: 30 }) })));
      expect(current()).toMatchObject({ status: terminal, replyText: "Final", leaderUpdatedAt: 30 });
    }
  });

  it("rejects an older assignment id arriving with the same timestamp as the new assignment", () => {
    syncLeaderBranchComms(publish(branch({ delegation: delegation({ state: "completed", updatedAt: 30, result: "Old" }) })));
    const next = delegation({ requestId: "assignment-2", runId: "run-2", createdAt: 40, updatedAt: 40, result: "New preview" });
    syncLeaderBranchComms(publish(branch({ delegation: next })));
    syncLeaderBranchComms(publish(branch({ delegation: delegation({ updatedAt: 40, result: "Late old preview" }) })));
    expect(current()).toMatchObject({ requestId: "assignment-2", runId: "run-2", replyText: "New preview", leaderUpdatedAt: 40 });
  });
});
