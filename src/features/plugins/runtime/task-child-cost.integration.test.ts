import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTaskConversationSnapshot, HostTaskCostApproval } from "@ccgui/plugin-sdk";
import { useChatStore } from "@/features/chat/store";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { syncLeaderBranchComms } from "@/features/leader/runtime";
import { useLeaderStore } from "@/features/leader/store";
import type { LeaderBranch, LeaderSnapshot } from "@/features/leader/types";
import { invoke } from "@/lib/transport";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import { captureTaskCostApproval, projectTaskCostApprovals, resolveTaskCostApproval, taskCostApprovalsChanged } from "./task-cost-review";
import type { HostTaskFacade, TaskSessionRef } from "./task-facade";

// Only the native transport and the outer host facade are controlled. In
// particular, no leader communication/cost projection/resolution is mocked.
vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));

const parent = { engine: "codex", sessionId: "coordinator", workspacePath: "G:/Synthetic/Coordinator" };
const child = { engine: "agy", sessionId: "gemini-child", workspacePath: "G:\\Synthetic\\Child" };
const originalMessage = "Synthetic task_send assignment 🙂\r\n";
function held(patch: Partial<LeaderBranch> = {}): LeaderBranch {
  return {
    id: "gemini-branch", parentEngine: parent.engine, parentSessionId: parent.sessionId,
    parentWorkspacePath: "G:\\Synthetic\\Coordinator", ...child,
    title: "Gemini worker", task: "Unrelated manual child continuation", model: "gemini-3.8-flash", effort: "high",
    runId: "manual-child-run", state: "running", createdAt: 1, updatedAt: 30, lastActivityAt: 30,
    deadlineAt: 1000, expired: false, result: "", resultTruncated: false, error: null,
    delegation: { requestId: "task-send-original", runId: null, task: originalMessage,
      state: "awaiting_cost_approval", createdAt: 10, updatedAt: 20, result: "", resultTruncated: false, error: null,
      costApproval: { requestId: "native-child-approval", capturedAt: 15, model: "gemini-3.8-flash" } },
    ...patch,
  };
}
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useCrossSessionActivityStore.setState({ records: [] });
  useChatStore.setState({ sessions: [], bySession: {} });
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, error: null });
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function fixture(initial = [held()]) {
  let snapshot: LeaderSnapshot = { leaders: [], branches: initial };
  const confirm = vi.fn(async (_approval: HostTaskCostApproval, _decision: string) => true);
  const continueMessage = vi.fn();
  const facade = {
    ready: async () => {}, known: () => true, openBackground: async () => {}, inspect: () => "idle" as const,
    conversationState: () => ({ messages: [], runId: null, status: "idle", canDeliver: true }),
    leaderBranches: async () => snapshot.branches,
    subscribe: (wake: () => void) => useCrossSessionActivityStore.subscribe((next, previous) => {
      if (taskCostApprovalsChanged(next.records, previous.records)) wake();
    }),
    listen: async () => () => {}, liveRun: () => null, settledRun: () => null,
    costApprovals: projectTaskCostApprovals, captureCostApproval: captureTaskCostApproval,
    resolveCostApproval: resolveTaskCostApproval, continueMessage,
    // A cold GPT coordinator must not replace the child task_send approval.
    sessionCostReview: () => ({ required: true, signature: "cold-coordinator-gpt", review: {
      capturedAt: 1, model: "gpt-coordinator", cacheHeat: "cold", targetStatus: "idle",
      context: { kind: "unknown", capacityKnown: false, reference: false, modelMismatch: false },
    } }),
  } satisfies Partial<HostTaskFacade>;
  function publish(branches: LeaderBranch[]) {
    snapshot = { leaders: [], branches };
    useLeaderStore.setState({ snapshot });
    syncLeaderBranchComms(snapshot);
  }
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "task_snapshot") return snapshot;
    if (command !== "task_resolve_cost_approval") throw new Error(`Unexpected native call: ${command}`);
    const decision = args as { branchId: string; requestId: string; approve: boolean };
    const branch = snapshot.branches.find(b => b.id === decision.branchId)!;
    if (branch.delegation?.costApproval?.requestId !== decision.requestId) throw new Error("Stale native approval");
    publish(snapshot.branches.map(b => b !== branch ? b : { ...b, delegation: { ...b.delegation!,
      state: decision.approve ? "running" : "failed", updatedAt: b.delegation!.updatedAt + 1, costApproval: undefined } }));
    return snapshot;
  });
  const refs: Record<string, TaskSessionRef> = {
    root: parent, other: { ...parent, sessionId: "other-coordinator" },
    workspaceTwin: { ...parent, workspacePath: "G:/Synthetic/Other" },
    engineTwin: { ...parent, engine: "agy" },
  };
  const bridge = createTaskConversationBridge({
    pluginId: "synthetic-child-cost", storage: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    owned: async id => {
      const ref = refs[id]; if (!ref) throw new Error("Unknown task");
      return { proven: true, receipt: { requestId: id, session: ref, workspacePath: ref.workspacePath,
        taskId: id, executionId: `execution-${id}`, projectId: "synthetic", slotKey: id, sessionDecision: "reused", runId: null,
        status: "completed", acceptedAt: 1, updatedAt: 1 } };
    },
    facade: async () => facade as unknown as HostTaskFacade, confirmCostReview: confirm,
    resolveImages: async ids => ids, handoffExcerpt: async () => ({ messages: [], nextBefore: null, truncated: false }), hold: () => {}, now: () => 100,
  });
  disposers.push(() => bridge.dispose()); publish(initial);
  return { bridge, confirm, continueMessage, publish };
}
function action(view: HostTaskConversationSnapshot, decision: "approve" | "cancel" = "approve") {
  const approval = view.costApprovals![0];
  return { type: "requestCostReview" as const, conversationRequestId: view.requestId,
    expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId, decision };
}
const decisions = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "task_resolve_cost_approval");

describe("task_send child cost approval through the workbench conversation bridge", () => {
  it("refreshes cache evidence at the retention boundary without a model or user action", async () => {
    vi.useFakeTimers(); const start = Date.UTC(2026, 9, 28, 4); vi.setSystemTime(start);
    try {
      const source = held();
      source.delegation!.costApproval = { requestId: "native-child-approval", model: "gemini-3.8-flash", capturedAt: start,
        cache: { startedAt: start, observedAt: start, ttlSeconds: 300, source: "anthropic-usage" } };
      const f = fixture([source]); const events: HostTaskConversationSnapshot[] = [];
      const off = f.bridge.onConversationEvent(view => events.push(view));
      const view = await f.bridge.conversation("root");
      expect(view.costApprovals![0].cacheHeat).toBe("hot");
      await vi.advanceTimersByTimeAsync(300_002);
      expect(events.at(-1)?.costApprovals?.[0].cacheHeat).toBe("cold");
      expect(decisions()).toEqual([]); expect(f.continueMessage).not.toHaveBeenCalled();
      off(); f.bridge.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("projects the Gemini zero-read cache reference and permits a read-only Handoff preview", async () => {
    const source = held();
    source.delegation!.costApproval!.cache = { startedAt: 1, observedAt: 2, ttlSeconds: 900,
      source: "agy-vertex-reference", reference: { maxTtlSeconds: 1200, cacheReadTokens: 0, promptTokens: 353093 } };
    const f = fixture([source]);
    const view = await f.bridge.conversation("root"), approval = view.costApprovals![0];
    expect(approval).toMatchObject({ kind: "leader", cacheHeat: "unknown", canHandoff: true,
      cacheReference: { promptTokens: 353093, cacheReadTokens: 0, observedAt: 2 } });
    const result = await f.bridge.previewCostHandoff!({ conversationRequestId: "root", expectedRevision: view.revision,
      approvalId: approval.id, approvalRequestId: approval.requestId });
    expect(result).toMatchObject({ kind: "leader", source: child, message: originalMessage });
    expect((await f.bridge.conversation("root")).costApprovals![0].requestId).toBe("native-child-approval");
    expect(decisions()).toEqual([]); expect(f.continueMessage).not.toHaveBeenCalled();
  });
  it("opens a new held delegation after the same child's previous assignment completed", async () => {
    const previous = held();
    previous.delegation = { ...previous.delegation!, state: "completed", costApproval: undefined, result: "Previous result" };
    const f = fixture([previous]);
    expect((await f.bridge.conversation("root")).costApprovals).toEqual([]);
    const next = held();
    next.delegation = { ...next.delegation!, requestId: "task-send-next", createdAt: 40, updatedAt: 41,
      costApproval: { requestId: "next-native-approval", capturedAt: 40, model: "gemini-3.8-flash" } };
    f.publish([next]);
    const view = await f.bridge.conversation("root");
    expect(view.children[0].delegation?.requestId).toBe("task-send-next");
    expect(view.costApprovals?.[0].requestId).toBe("next-native-approval");
    // A late previous completion cannot hide the new held delegation.
    f.publish([previous]);
    expect((await f.bridge.conversation("root")).costApprovals?.[0].requestId).toBe("next-native-approval");
    f.publish([next]);
    const refreshed = await f.bridge.conversation("root");
    await f.bridge.conversationAction("root", action(refreshed));
    expect(decisions()[0][1]).toMatchObject({ requestId: "next-native-approval", reviewedModel: "gemini-3.8-flash" });
  });

  it("approves only Gemini when the coordinator's GPT input has a separate simultaneous review", async () => {
    const f = fixture();
    await f.bridge.sendMessage({ conversationRequestId: "root", requestId: "gpt-input", expectedInputRevision: 0, prompt: "Synthetic coordinator continuation" });
    await f.bridge.drain();
    const view = await f.bridge.conversation("root");
    expect(view.costApprovals).toHaveLength(2);
    expect(view.costApprovals?.find(a => a.requestId === "gpt-input")).toMatchObject({ kind: "coordinatorInput", model: "gpt-coordinator", target: parent });
    const gemini = view.costApprovals!.find(a => a.requestId === "native-child-approval")!;
    await f.bridge.conversationAction("root", { ...action(view), approvalId: gemini.id, approvalRequestId: gemini.requestId });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0][1]).toMatchObject({ branchId: "gemini-branch", requestId: "native-child-approval", reviewedModel: "gemini-3.8-flash" });
    const next = await f.bridge.conversation("root");
    expect(next.costApprovals).toHaveLength(1);
    expect(next.costApprovals![0]).toMatchObject({ requestId: "gpt-input", model: "gpt-coordinator" });
    expect(f.continueMessage).not.toHaveBeenCalled();
  });

  it.each(["approve", "cancel"] as const)("projects the Gemini child and resolves the original native request after human %s", async decision => {
    const f = fixture();
    const view = await f.bridge.conversation("root");
    expect(view.children).toMatchObject([{ id: "gemini-branch", sessionRef: child,
      delegation: { requestId: "task-send-original", state: "awaiting_cost_approval" } }]);
    expect(view.costApprovals).toHaveLength(1);
    expect(view.costApprovals![0]).toMatchObject({ id: "leader:gemini-branch", requestId: "native-child-approval",
      sender: { ...parent, workspacePath: "G:\\Synthetic\\Coordinator" }, target: { ...child, title: "Gemini worker" },
      message: originalMessage, model: "gemini-3.8-flash" });
    expect(captureTaskCostApproval([parent], view.costApprovals![0])).toMatchObject({ kind: "leader", message: originalMessage });
    expect(decisions()).toEqual([]);
    await f.bridge.conversationAction("root", action(view, decision));
    const next = await f.bridge.conversation("root");
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(view.costApprovals![0], decision);
    expect(decisions()).toEqual([["task_resolve_cost_approval", { parentEngine: "codex", parentSessionId: "coordinator",
      workspacePath: "G:\\Synthetic\\Coordinator", branchId: "gemini-branch", requestId: "native-child-approval",
      approve: decision === "approve", reviewedModel: "gemini-3.8-flash" }]]);
    expect(next.costApprovals).toEqual([]);
    expect(f.continueMessage).not.toHaveBeenCalled();
  });

  it("leaves the child held when the human dismisses the system confirmation", async () => {
    const f = fixture(); f.confirm.mockResolvedValue(false);
    const view = await f.bridge.conversation("root");
    await f.bridge.conversationAction("root", action(view));
    const next = await f.bridge.conversation("root");
    expect(next.costApprovals).toEqual(view.costApprovals);
    expect(decisions()).toEqual([]); expect(f.continueMessage).not.toHaveBeenCalled();
  });

  it.each(["state", "request", "target", "messageTail"] as const)("rejects a changed %s while the human confirmation is pending", async change => {
    const original = held();
    if (change === "messageTail") original.delegation!.task = "🙂".repeat(1200) + "old tail";
    const f = fixture([original]); let release!: (confirmed: boolean) => void;
    f.confirm.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const view = await f.bridge.conversation("root");
    const pending = f.bridge.conversationAction("root", action(view));
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    const changed = structuredClone(original); changed.delegation!.updatedAt++;
    if (change === "state") changed.delegation!.state = "running";
    if (change === "request") changed.delegation!.costApproval!.requestId = "replacement-approval";
    if (change === "target") changed.sessionId = "replacement-child";
    if (change === "messageTail") changed.delegation!.task = "🙂".repeat(1200) + "new tail";
    f.publish([changed]); release(true);
    await expect(pending).rejects.toThrow(/changed|available|confirmed/i);
    expect(decisions()).toEqual([]); expect(f.continueMessage).not.toHaveBeenCalled();
  });

  it("keeps session, engine and workspace twins isolated even when another coordinator shares the target", async () => {
    const foreign = held({ id: "foreign-branch", parentSessionId: "other-coordinator" });
    const f = fixture([held(), foreign]);
    expect((await f.bridge.conversation("root")).costApprovals?.map(a => a.id)).toEqual(["leader:gemini-branch"]);
    expect((await f.bridge.conversation("other")).costApprovals?.map(a => a.id)).toEqual(["leader:foreign-branch"]);
    for (const id of ["workspaceTwin", "engineTwin"]) {
      const view = await f.bridge.conversation(id);
      expect(view.costApprovals).toEqual([]); expect(view.children).toEqual([]);
    }
    expect(decisions()).toEqual([]);
  });

  it("publishes optional held-child association asynchronously and then replaces its provisional target", async () => {
    const f = fixture([]);
    expect((await f.bridge.conversation("root")).costApprovals).toEqual([]);
    const updates: HostTaskConversationSnapshot[] = [];
    disposers.push(f.bridge.onConversationEvent(view => { updates.push(view); }));
    await Promise.resolve(); f.publish([held({ sessionId: null })]);
    await vi.waitFor(() => expect(updates.some(view => view.costApprovals?.[0]?.target.sessionId === "leader-branch:gemini-branch")).toBe(true));
    const associated = held(); associated.delegation!.updatedAt++;
    await Promise.resolve(); f.publish([associated]);
    await vi.waitFor(() => expect(updates.at(-1)?.costApprovals?.[0]?.target.sessionId).toBe(child.sessionId));
    expect(updates.at(-1)?.children[0].sessionRef).toEqual(child);
    expect(updates.at(-1)?.costApprovals?.[0]).toMatchObject({ model: "gemini-3.8-flash", requestId: "native-child-approval" });
    expect(decisions()).toEqual([]); expect(f.continueMessage).not.toHaveBeenCalled();
  });
});
