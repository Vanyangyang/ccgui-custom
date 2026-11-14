import { afterEach, describe, expect, it, vi } from "vitest";
import { useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "@/features/chat/cross-session";
import { handoffLeaderCostApproval, resolveLeaderCostApproval } from "./cost-approval";

const native = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/transport", () => ({ invoke: native.invoke, isWeb: false, listen: vi.fn(async () => () => {}) }));
vi.mock("./store", () => ({ useLeaderStore: { getState: () => ({ refresh: native.refresh }) } }));

const held = (): CrossSessionCommunicationRecord => ({
  scopedId: "leader:child", requestId: "old-assignment", status: "awaiting_cost_approval", kind: "subtask",
  sender: { engine: "codex", sessionId: "parent", workspacePath: "G:/parent" },
  target: { engine: "agy", sessionId: "child-session", workspacePath: "G:/child" },
  message: "完整原始任务🙂", acceptedAt: 1, updatedAt: 1,
  leaderCostApproval: { branchId: "child", requestId: "held-request", model: "gemini" },
});

afterEach(() => { useCrossSessionActivityStore.getState().reset(); vi.resetAllMocks(); });

describe("managed child cost handoff", () => {
  it("rejects an old image identity even when the pending text and model are unchanged", async () => {
    const record = { ...held(), imageRefs: [`task-image:${"a".repeat(64)}`] };
    useCrossSessionActivityStore.getState().upsertRecord({ ...record, imageRefs: [`task-image:${"b".repeat(64)}`] });
    await expect(handoffLeaderCostApproval(record, "摘要", "image-op")).rejects.toThrow("changed");
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("passes the exact held identity and user summary to the native handoff command", async () => {
    const record = held(); useCrossSessionActivityStore.getState().upsertRecord(record);
    native.invoke.mockResolvedValue({}); native.refresh.mockResolvedValue(undefined);
    await handoffLeaderCostApproval(record, "摘要🙂\n下一步", "handoff-op-1");
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("task_handoff_child", {
      parentEngine: "codex", parentSessionId: "parent", workspacePath: "G:/parent", branchId: "child", requestId: "held-request",
      sourceSessionId: "child-session", reviewedModel: "gemini", operationId: "handoff-op-1", summary: "摘要🙂\n下一步",
    });
    expect(native.refresh).toHaveBeenCalledOnce();
  });
  it("rejects stale or replaced held content before invoking the native command", async () => {
    const record = held(); useCrossSessionActivityStore.getState().upsertRecord({ ...record, message: "新内容" });
    await expect(handoffLeaderCostApproval(record, "摘要", "handoff-op-1")).rejects.toThrow("changed");
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("coalesces an identical handoff but rejects a competing approve or different handoff", async () => {
    const record = held(); useCrossSessionActivityStore.getState().upsertRecord(record);
    let finish!: () => void;
    native.invoke.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; })); native.refresh.mockResolvedValue(undefined);
    const first = handoffLeaderCostApproval(record, "摘要", "handoff-op-1");
    const duplicate = handoffLeaderCostApproval(record, "摘要", "handoff-op-1");
    expect(duplicate).toBe(first);
    await expect(resolveLeaderCostApproval(record, true)).rejects.toThrow("in progress");
    await expect(handoffLeaderCostApproval(record, "另一摘要", "handoff-op-1")).rejects.toThrow("in progress");
    expect(native.invoke).toHaveBeenCalledOnce(); finish(); await first;
  });
  it("keeps the same operation identity on an explicit retry after an uncertain error", async () => {
    const record = held(); useCrossSessionActivityStore.getState().upsertRecord(record);
    native.invoke.mockRejectedValueOnce(new Error("response unavailable")).mockResolvedValueOnce({}); native.refresh.mockResolvedValue(undefined);
    await expect(handoffLeaderCostApproval(record, "摘要", "handoff-op-1")).rejects.toThrow("response unavailable");
    await handoffLeaderCostApproval(record, "摘要", "handoff-op-1");
    expect(native.invoke.mock.calls[0][1]).toEqual(native.invoke.mock.calls[1][1]);
  });
});
