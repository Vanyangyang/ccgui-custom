import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTaskManagedHandoffRequest, HostTaskCostApproval, HostTaskSelection } from "@ccgui/plugin-sdk";
import { useChatStore } from "@/features/chat/store";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { syncLeaderBranchComms } from "@/features/leader/runtime";
import { useLeaderStore } from "@/features/leader/store";
import { HandoffTargetSelectionError, resolveLeaderCostApproval } from "@/features/leader/cost-approval";
import type { LeaderBranch, LeaderSnapshot } from "@/features/leader/types";
import { invoke } from "@/lib/transport";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import { captureTaskCostApproval, projectTaskCostApprovals, resolveTaskCostApproval, handoffTaskCostApproval } from "./task-cost-review";
import type { HostTaskFacade } from "./task-facade";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
const parent = { engine: "codex", sessionId: "parent", workspacePath: "G:/Synthetic/Parent" };
const child = { engine: "agy", sessionId: "child-a", workspacePath: "G:/Synthetic/Child" };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function held(): LeaderBranch {
  return { id: "branch-a", parentEngine: parent.engine, parentSessionId: parent.sessionId, parentWorkspacePath: parent.workspacePath,
    ...child, title: "Synthetic child", task: "Initial task", model: "gemini", effort: "high", runId: null,
    state: "completed", createdAt: 1, updatedAt: 20, lastActivityAt: 20, deadlineAt: 100, expired: false,
    result: "", resultTruncated: false, error: null,
    delegation: { requestId: "assignment-a", runId: null, task: "Original message 🙂\r\n", state: "awaiting_cost_approval",
      createdAt: 10, updatedAt: 20, result: "", resultTruncated: false, error: null,
      costApproval: { requestId: "approval-a", capturedAt: 10, model: "gemini" } } };
}
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useCrossSessionActivityStore.setState({ records: [] });
  useChatStore.setState({ sessions: [], bySession: {}, openTabs: [], archivedSessionKeys: {} });
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, error: null });
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
function fixture() {
  let snapshot: LeaderSnapshot = { leaders: [], branches: [held()] };
  let proven = true;
  let nativeGate: Promise<void> | undefined;
  let nativeError: Error | undefined;
  let omitSuccessor = false;
  let historyVersion = "saved-history-v1";
  const excerpt = { messages: [{ seq: 1, role: "assistant" as const, text: "Source context", truncated: false }], nextBefore: null, truncated: false };
  const loadExcerpt = vi.fn(async () => structuredClone(excerpt));
  const confirm = vi.fn(async (_approval: HostTaskCostApproval, _summary: string, _targetSelection?: HostTaskSelection) => true);
  const supported = vi.fn(async () => true);
  const selectionSupported = vi.fn(async () => true);
  const resolveSelection = vi.fn(async (selection: HostTaskSelection) => ({ ...selection }));
  const summarize = vi.fn(async (_ref: typeof child, _selection: { engine: string; model: string }) => "全历史摘要：保留最早决定与未解决错误 E_BUSY_42。");
  const fullSupported = vi.fn(async () => true);
  const facade = {
    ready: async () => {}, openBackground: async () => {}, inspect: () => "idle" as const,
    conversationState: () => ({ messages: [], runId: null, status: "idle", canDeliver: true }),
    leaderBranches: async () => snapshot.branches, subscribe: () => () => {}, listen: async () => () => {},
    liveRun: () => null, settledRun: () => null,
    costApprovals: projectTaskCostApprovals, captureCostApproval: captureTaskCostApproval,
    resolveCostApproval: resolveTaskCostApproval, handoffCostApproval: handoffTaskCostApproval,
    managedChildHandoffSupported: supported,
    managedChildHandoffSelectionSupported: selectionSupported, resolveHandoffSelection: resolveSelection,
    fullHistoryHandoffSupported: fullSupported, summarizeHandoff: summarize,
    costContextVersion: () => historyVersion,
  } satisfies Partial<HostTaskFacade>;
  function publish(branches: LeaderBranch[]) { snapshot = { leaders: [], branches }; useLeaderStore.setState({ snapshot }); syncLeaderBranchComms(snapshot); }
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "task_snapshot") return snapshot;
    if (command === "task_resolve_cost_approval") {
      const decision = args as { branchId: string; approve: boolean };
      publish(snapshot.branches.map(b => b.id !== decision.branchId ? b : { ...b,
        delegation: { ...b.delegation!, state: decision.approve ? "running" : "failed", costApproval: undefined } }));
      return snapshot;
    }
    if (command !== "task_handoff_child") throw new Error(`Unexpected transport: ${command}`);
    if (nativeGate) await nativeGate;
    if (nativeError) throw nativeError;
    if (omitSuccessor) return snapshot;
    const request = args as { branchId: string; requestId: string; operationId: string; summary: string };
    const original = snapshot.branches.find(b => b.id === request.branchId)!;
    const successorId = `${request.branchId}-next`;
    const link = { branchId: successorId, requestId: request.requestId, operationId: request.operationId, payloadFingerprint: "private-fingerprint" };
    publish([...snapshot.branches.map(b => b !== original ? b : { ...b, state: "handed_off" as const, handoffTo: link,
      delegation: { ...b.delegation!, state: "handed_off" as const, costApproval: undefined } }),
    { ...original, id: successorId, sessionId: `${original.sessionId}-next`, state: "starting", delegation: undefined,
      handoffFrom: { ...link, branchId: original.id, requestId: request.requestId } }]);
    return snapshot;
  });
  const bridge = createTaskConversationBridge({ pluginId: "managed-fixture",
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    owned: async id => {
      if (id !== "root") throw new Error("Not this plugin's coordinator");
      return { proven, receipt: { requestId: id, taskId: id, executionId: "execution", projectId: "project", slotKey: id,
        workspacePath: parent.workspacePath, session: parent, sessionDecision: "reused", runId: null, status: "completed", acceptedAt: 1, updatedAt: 1 } };
    }, facade: async () => facade as unknown as HostTaskFacade,
    confirmCostReview: async () => true, confirmManagedHandoff: confirm,
    handoffExcerpt: loadExcerpt, resolveImages: async ids => ids, hold: () => {}, now: () => 100,
  });
  disposers.push(bridge.dispose); publish(snapshot.branches);
  async function request(): Promise<HostTaskManagedHandoffRequest> {
    const view = await bridge.conversation("root"), approval = view.costApprovals![0];
    const base = { conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId };
    const preview = await bridge.previewCostHandoff!(base);
    return { ...base, sourceStamp: preview.sourceStamp, operationId: "operation-a", summary: "Confirmed synthetic summary 🙂" };
  }
  return { bridge, facade, confirm, supported, selectionSupported, resolveSelection, fullSupported, summarize, excerpt, loadExcerpt, request, publish, branches: () => snapshot.branches,
    setProven: (value: boolean) => { proven = value; }, gate: (promise: Promise<void>) => { nativeGate = promise; }, fail: (error: Error) => { nativeError = error; },
    omitSuccessor: () => { omitSuccessor = true; }, changeHistoryVersion: () => { historyVersion = "saved-history-v2"; } };
}
const handoffs = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "task_handoff_child");

describe("managed child handoff through the host-confirmed SDK bridge", () => {
  it("keeps a captured child review valid while target resolution waits and an unrelated sibling changes the parent revision", async () => {
    const f = fixture(), request = await f.request(), resolution = deferred<HostTaskSelection>();
    const target = { engine: "claude", model: "opus", providerId: "__local_settings_json__", effort: "xhigh" };
    f.resolveSelection.mockReturnValueOnce(resolution.promise);
    const flight = f.bridge.handoffManagedChild!({ ...request, targetSelection: target });
    await vi.waitFor(() => expect(f.resolveSelection).toHaveBeenCalledOnce());
    const source = f.branches()[0];
    f.publish([source, { ...source, id: "unrelated-sibling", sessionId: "sibling-session", state: "running", runId: "sibling-run", delegation: undefined }]);
    expect((await f.bridge.conversation("root")).revision).toBeGreaterThan(request.expectedRevision);
    resolution.resolve(target);
    expect((await flight).status).toBe("accepted");
    expect(f.confirm).toHaveBeenCalledOnce(); expect(handoffs()).toHaveLength(1);
  });
  it("rejects changes to the actual held task while target resolution waits", async () => {
    const f = fixture(), request = await f.request(), resolution = deferred<HostTaskSelection>();
    const target = { engine: "claude", model: "opus", providerId: "__local_settings_json__", effort: "xhigh" };
    f.resolveSelection.mockReturnValueOnce(resolution.promise);
    const flight = f.bridge.handoffManagedChild!({ ...request, targetSelection: target });
    await vi.waitFor(() => expect(f.resolveSelection).toHaveBeenCalledOnce());
    const source = held(); source.delegation!.task = "Changed held task"; f.publish([source]);
    resolution.resolve(target);
    expect(await flight).toMatchObject({ status: "not_submitted" });
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
  });
  it("distinguishes target policy denial without exposing native exception text or changing the source", async () => {
    const f = fixture(), request = await f.request();
    f.resolveSelection.mockRejectedValue(new HandoffTargetSelectionError("HANDOFF_TARGET_NOT_ALLOWED"));
    const result = await f.bridge.handoffManagedChild!({ ...request,
      targetSelection: { engine: "claude", model: "opus", providerId: "__local_settings_json__", effort: "xhigh" } });
    expect(result).toMatchObject({ status: "not_submitted", operationId: request.operationId });
    if (result.status !== "not_submitted") throw new Error("Expected a preflight rejection");
    expect(result.reason).toMatch(/not allowed|允许名单/);
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
    expect((await f.bridge.conversation("root")).costApprovals).toHaveLength(1);
  });
  it("shares the same safe preflight reason for identical overlapping operations", async () => {
    const f = fixture(), request = { ...await f.request(),
      targetSelection: { engine: "claude", model: "opus", providerId: "__local_settings_json__", effort: "xhigh" } };
    const gate = deferred<void>();
    f.resolveSelection.mockImplementationOnce(async () => { await gate.promise; throw new HandoffTargetSelectionError("HANDOFF_TARGET_NOT_ALLOWED"); });
    const first = f.bridge.handoffManagedChild!(request);
    await vi.waitFor(() => expect(f.resolveSelection).toHaveBeenCalledOnce());
    const second = f.bridge.handoffManagedChild!(structuredClone(request));
    gate.resolve();
    const result = await first;
    expect(result).toMatchObject({ status: "not_submitted" }); expect(await second).toEqual(result);
    expect(f.resolveSelection).toHaveBeenCalledOnce(); expect(handoffs()).toEqual([]);
  });
  it("freezes the independent successor selection, confirms its resolved model and sends it without changing the reviewed source", async () => {
    const f = fixture(), dialog = deferred<boolean>();
    const target = { engine: "codex", model: "chosen-model", providerId: "chosen-channel", effort: "high" };
    const request = { ...await f.request(), targetSelection: { ...target } };
    f.confirm.mockReturnValue(dialog.promise);
    const flight = f.bridge.handoffManagedChild!(request);
    request.targetSelection.model = "late-model";
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.confirm.mock.calls[0]).toEqual([expect.objectContaining({ model: "gemini", target: expect.objectContaining({ engine: "agy" }) }), request.summary, target]);
    dialog.resolve(true); expect((await flight).status).toBe("accepted");
    expect(handoffs()[0][1]).toMatchObject({ reviewedModel: "gemini", sourceSessionId: "child-a", targetSelection: target });
    expect(f.resolveSelection.mock.calls.every(([selection]) => selection.model === "chosen-model")).toBe(true);
    expect(f.summarize).not.toHaveBeenCalled();
  });
  it("shows a resolved alias and refuses a changed alias mapping during confirmation", async () => {
    const f = fixture(), dialog = deferred<boolean>(), requested = { engine: "claude", model: "opus", providerId: "channel", effort: "high" };
    f.resolveSelection.mockImplementation(async selection => ({ ...selection, model: "fixed-one" }));
    f.confirm.mockReturnValue(dialog.promise);
    const flight = f.bridge.handoffManagedChild!({ ...await f.request(), targetSelection: requested });
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.confirm.mock.calls[0][2]).toEqual({ ...requested, model: "fixed-one" });
    f.resolveSelection.mockImplementation(async selection => ({ ...selection, model: "fixed-two" }));
    dialog.resolve(true);
    expect(await flight).toMatchObject({ status: "not_submitted" }); expect(handoffs()).toEqual([]);
  });
  it("submits the fixed successor model shown in confirmation when an allowed alias resolves consistently", async () => {
    const f = fixture(), request = await f.request();
    const requested = { engine: "claude", model: "opus", providerId: "__local_settings_json__", effort: "xhigh" };
    const resolved = { ...requested, model: "fixed-opus-from-selected-cli" };
    f.resolveSelection.mockResolvedValue(resolved);
    expect((await f.bridge.handoffManagedChild!({ ...request, targetSelection: requested })).status).toBe("accepted");
    expect(f.confirm.mock.calls[0][2]).toEqual(resolved);
    expect(handoffs()[0][1]).toMatchObject({ reviewedModel: "gemini", targetSelection: resolved });
    expect(f.resolveSelection.mock.calls).toEqual([[requested], [requested]]);
  });
  it("does not coalesce the same operation with a different successor model", async () => {
    const f = fixture(), dialog = deferred<boolean>(); f.confirm.mockReturnValue(dialog.promise);
    const request = { ...await f.request(), targetSelection: { engine: "codex", model: "one", providerId: "channel", effort: "high" } };
    const flight = f.bridge.handoffManagedChild!(request);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    await expect(f.bridge.handoffManagedChild!({ ...request, targetSelection: { ...request.targetSelection, model: "two" } })).rejects.toThrow("different payload");
    dialog.resolve(false); expect((await flight).status).toBe("cancelled"); expect(handoffs()).toEqual([]);
  });
  it.each(["legacy", "invalid", "unavailable", "wrong-engine", "wrong-provider"])("refuses %s successor selection before confirmation", async kind => {
    const f = fixture(), target = { engine: "codex", model: "chosen", providerId: "channel", effort: "high" };
    if (kind === "legacy") f.selectionSupported.mockResolvedValue(false);
    if (kind === "invalid") target.effort = "not-an-effort";
    if (kind === "unavailable") f.resolveSelection.mockRejectedValue(new Error("selection unavailable"));
    if (kind === "wrong-engine") f.resolveSelection.mockImplementation(async selection => ({ ...selection, engine: "claude" }));
    if (kind === "wrong-provider") f.resolveSelection.mockImplementation(async selection => ({ ...selection, providerId: "another" }));
    expect(await f.bridge.handoffManagedChild!({ ...await f.request(), targetSelection: target })).toMatchObject({ status: "not_submitted" });
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
  });
  it("shows the complete frozen pending assignment even when the review card is shortened", async () => {
    const f = fixture(), source = held();
    source.delegation!.task = "完整待发要求🙂\r\n".repeat(500) + "原文尾部必须可核对";
    f.publish([source]);
    const view = await f.bridge.conversation("root");
    expect(view.costApprovals![0].truncated).toBe(true);
    expect(view.costApprovals![0].message).not.toContain("原文尾部必须可核对");
    f.confirm.mockResolvedValueOnce(false);
    const result = await f.bridge.handoffManagedChild!(await f.request());
    expect(result.status).toBe("cancelled");
    expect(f.confirm.mock.calls[0][0]).toMatchObject({ message: source.delegation!.task, truncated: false });
    expect(handoffs()).toEqual([]);
  });
  it.each(["before", "during", "native-only"])("rejects same-text image replacement %s confirmation", async phase => {
    const f = fixture(), next = held(), image = (sha: string) => ({ source: "original", path: "G:/private/image.png", sha256: sha.repeat(64) });
    next.delegation!.images = [image("a"), image("b")]; f.publish([next]);
    const request = await f.request(), dialog = deferred<boolean>();
    f.confirm.mockReturnValue(dialog.promise);
    if (phase === "before") f.publish([{ ...next, delegation: { ...next.delegation!, images: [image("b"), image("a")] } }]);
    const flight = f.bridge.handoffManagedChild!(request);
    if (phase !== "before") {
      await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
      if (phase === "native-only") next.delegation!.images = [image("c")];
      else f.publish([{ ...next, delegation: { ...next.delegation!, images: [image("c")] } }]);
    }
    dialog.resolve(true);
    expect(await flight).toMatchObject({ status: "not_submitted" }); expect(handoffs()).toEqual([]);
  });
  it("preserves native image identities in a leader preview without exposing paths", async () => {
    const f = fixture(), next = held();
    Object.assign(next.delegation!, { images: [{ source: "private-source", path: "G:/private/image.png", sha256: "a".repeat(64) }] });
    f.publish([next]);
    const request = await f.request();
    const preview = await f.bridge.previewCostHandoff!(request);
    expect(preview.images).toEqual([`task-image:${"a".repeat(64)}`]);
    expect(JSON.stringify(preview)).not.toContain("private-source");
    expect(JSON.stringify(preview)).not.toContain("G:/private");
  });
  it("invalidates approval when older history changes beyond an unchanged preview excerpt", async () => {
    const f = fixture(), request = await f.request(), dialog = deferred<boolean>();
    f.confirm.mockReturnValue(dialog.promise);
    const flight = f.bridge.handoffManagedChild!(request);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    f.changeHistoryVersion(); dialog.resolve(true);
    expect(await flight).toMatchObject({ status: "not_submitted", operationId: request.operationId });
    expect(handoffs()).toEqual([]);
  });
  it("compresses the owned child's full native source with an independent selected model without approving or sending", async () => {
    const f = fixture(), request = await f.request();
    const { operationId: _operation, summary: _summary, ...identity } = request;
    const source = { kind: "managedChild" as const, ...identity };
    const selection = { engine: "codex" as const, model: "independent-compressor", effort: "high" };
    expect(await f.bridge.summarizeManagedHandoff(source, selection)).toContain("最早决定");
    expect(f.summarize).toHaveBeenCalledExactlyOnceWith({ ...child, title: "Synthetic child" }, selection);
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "task_resolve_cost_approval")).toBe(false);
    expect((await f.bridge.conversation("root")).costApprovals).toHaveLength(1);
  });
  it.each(["foreign", "stamp", "legacy", "owner"] as const)("rejects an invalid full-history source %s before a model call", async kind => {
    const f = fixture(), request = await f.request();
    const source = { kind: "managedChild" as const, ...request };
    if (kind === "foreign") source.conversationRequestId = "foreign";
    if (kind === "stamp") source.sourceStamp = "0".repeat(64);
    if (kind === "legacy") f.fullSupported.mockResolvedValue(false);
    if (kind === "owner") f.setProven(false);
    await expect(f.bridge.summarizeManagedHandoff(source, { engine: "cursor", model: "chosen" })).rejects.toThrow();
    expect(f.summarize).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
  });
  it("rejects a late full-history result if the pending task changes while compressing", async () => {
    const f = fixture(), request = await f.request(), result = deferred<string>();
    f.summarize.mockReturnValue(result.promise);
    const flight = f.bridge.summarizeManagedHandoff({ kind: "managedChild", ...request }, { engine: "cursor", model: "chosen" });
    const failure = expect(flight).rejects.toThrow();
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledOnce());
    const next = held(); next.delegation!.task = "Changed full pending assignment"; f.publish([next]);
    result.resolve("Old source summary must not be adopted"); await failure;
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
  });
  it("confirms the exact summary and sends the original leader identity; successor keeps the coordinator active", async () => {
    const f = fixture(), request = await f.request();
    const result = await f.bridge.handoffManagedChild!(request);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected native successor acceptance");
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "leader", requestId: "approval-a", model: "gemini" }), request.summary);
    expect(handoffs()).toEqual([["task_handoff_child", { parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: parent.workspacePath,
      branchId: "branch-a", requestId: "approval-a", sourceSessionId: child.sessionId, reviewedModel: "gemini", operationId: request.operationId, summary: request.summary }]]);
    expect(result.snapshot.status).toBe("running");
    expect(result.snapshot.children).toMatchObject([{ id: "branch-a", state: "handed_off", handoffTo: { branchId: "branch-a-next", operationId: request.operationId } },
      { id: "branch-a-next", state: "starting", handoffFrom: { branchId: "branch-a", operationId: request.operationId } }]);
    expect(JSON.stringify(result.snapshot)).not.toContain("private-fingerprint");
  });
  it("dismissal returns cancelled without touching the ledger even with plugin-supplied approval booleans", async () => {
    const f = fixture(); f.confirm.mockResolvedValue(false);
    const result = await f.bridge.handoffManagedChild!({ ...await f.request(), confirmed: true, approved: true } as HostTaskManagedHandoffRequest);
    expect(result.status).toBe("cancelled"); expect(handoffs()).toEqual([]);
    if (result.status !== "cancelled") throw new Error("Expected dialog cancellation");
    expect(result.snapshot.costApprovals).toHaveLength(1);
  });
  it("freezes mutable plugin summary and request fields before any await", async () => {
    const f = fixture(), request = await f.request(), original = structuredClone(request), dialog = deferred<boolean>();
    f.confirm.mockReturnValue(dialog.promise);
    const flight = f.bridge.handoffManagedChild!(request);
    request.summary = "Malicious replacement"; request.operationId = "replacement-operation";
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.confirm.mock.calls[0][1]).toBe(original.summary);
    dialog.resolve(true); await flight;
    expect(handoffs()[0][1]).toMatchObject({ summary: original.summary, operationId: original.operationId });
  });
  it.each(["target", "request", "message-tail", "model", "owner", "workspace", "source-stamp"] as const)("reports this call not submitted after %s changes during confirmation", async change => {
    const f = fixture(), original = held();
    if (change === "message-tail") { original.delegation!.task = "A".repeat(1300) + "tail-one"; f.publish([original]); }
    const request = await f.request(), dialog = deferred<boolean>(); f.confirm.mockReturnValue(dialog.promise);
    const flight = f.bridge.handoffManagedChild!(request);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    const next = structuredClone(original); next.updatedAt++; next.delegation!.updatedAt++;
    if (change === "target") next.sessionId = "replacement-target";
    if (change === "request") next.delegation!.costApproval!.requestId = "replacement-request";
    if (change === "message-tail") next.delegation!.task = "A".repeat(1300) + "tail-two";
    if (change === "model") next.delegation!.costApproval!.model = "replacement-model";
    if (change === "owner") f.setProven(false);
    if (change === "workspace") next.parentWorkspacePath = "G:/Synthetic/Other";
    if (change === "source-stamp") f.excerpt.messages[0].text = "Different source context";
    f.publish([next]); dialog.resolve(true);
    expect(await flight).toMatchObject({ status: "not_submitted", operationId: request.operationId, reason: expect.any(String) });
    expect(handoffs()).toEqual([]);
  });
  it.each(["operation", "summary", "stamp", "revision", "foreign", "legacy"] as const)("rejects invalid %s before showing confirmation", async kind => {
    const f = fixture(), request = await f.request();
    if (kind === "operation") request.operationId = "contains spaces";
    if (kind === "summary") request.summary = "x".repeat(8001);
    if (kind === "stamp") request.sourceStamp = "0".repeat(64);
    if (kind === "revision") request.expectedRevision++;
    if (kind === "foreign") request.conversationRequestId = "foreign";
    if (kind === "legacy") f.supported.mockResolvedValue(false);
    if (kind === "operation") await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow("operation identity");
    else expect(await f.bridge.handoffManagedChild!(request)).toMatchObject({ status: "not_submitted", operationId: request.operationId });
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
  });
  it("coalesces an identical pending operation and rejects changed payload or competing SDK decisions", async () => {
    const f = fixture(), request = await f.request(), dialog = deferred<boolean>(); f.confirm.mockReturnValue(dialog.promise);
    const first = f.bridge.handoffManagedChild!(request), second = f.bridge.handoffManagedChild!(structuredClone(request));
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    await expect(f.bridge.handoffManagedChild!({ ...request, summary: "different" })).rejects.toThrow("different payload");
    for (const decision of ["approve", "cancel"] as const) await expect(f.bridge.conversationAction("root", { ...request, type: "requestCostReview", decision })).rejects.toThrow("already open");
    dialog.resolve(true); expect(await first).toEqual(await second); expect(handoffs()).toHaveLength(1);
    await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow(); expect(handoffs()).toHaveLength(1);
  });
  it.each([true, false])("lets native approve=%s settle while the dialog is open and refuses its late handoff confirmation", async approve => {
    const f = fixture(), request = await f.request(), dialog = deferred<boolean>(); f.confirm.mockReturnValue(dialog.promise);
    const record = useCrossSessionActivityStore.getState().records[0];
    const flight = f.bridge.handoffManagedChild!(request);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect((await f.bridge.conversation("root")).costApprovals).toHaveLength(1);
    await resolveLeaderCostApproval(record, approve);
    dialog.resolve(true); expect(await flight).toMatchObject({ status: "not_submitted", operationId: request.operationId }); expect(handoffs()).toHaveLength(0);
  });
  it("keeps inspection responsive during native launch and shares the native approve/cancel exclusion", async () => {
    const f = fixture(), request = await f.request(), gate = deferred<void>(); f.gate(gate.promise);
    const record = useCrossSessionActivityStore.getState().records[0];
    const flight = f.bridge.handoffManagedChild!(request);
    await vi.waitFor(() => expect(handoffs()).toHaveLength(1));
    expect(f.bridge.pendingManagedHandoff()).toBe(true);
    const view = await f.bridge.conversation("root"); expect(view.costApprovals).toHaveLength(1);
    for (const approve of [true, false]) await expect(resolveLeaderCostApproval(record, approve)).rejects.toThrow("in progress");
    gate.resolve(); expect((await flight).status).toBe("accepted"); expect(f.bridge.pendingManagedHandoff()).toBe(false);
  });
  it("does not retry uncertain native outcomes", async () => {
    const f = fixture(), request = await f.request(); f.fail(new Error("Synthetic transport outcome unknown"));
    await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow("outcome unknown");
    await f.bridge.drain(); await f.bridge.conversation("root"); expect(handoffs()).toHaveLength(1);
    // A later preflight failure cannot relabel a previously crossed operation
    // as not_submitted, even if this new invocation never reaches transport.
    await expect(f.bridge.handoffManagedChild!({ ...request, expectedRevision: request.expectedRevision + 100 })).rejects.toThrow("already submitted");
    expect(handoffs()).toHaveLength(1);
  });
  it("returns a safe reason and the frozen original operation ID when source loading fails before submission", async () => {
    const f = fixture(), request = await f.request(), originalOperation = request.operationId;
    request.summary = "PRIVATE_SUMMARY_DO_NOT_EXPOSE";
    f.loadExcerpt.mockRejectedValueOnce(new Error("PRIVATE_SOURCE_DO_NOT_EXPOSE"));
    const flight = f.bridge.handoffManagedChild!(request); request.operationId = "mutated-after-call";
    const result = await flight;
    expect(result).toMatchObject({ status: "not_submitted", operationId: originalOperation, reason: expect.any(String) });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|mutated-after-call/);
    expect(result).not.toHaveProperty("snapshot");
    expect(f.confirm).not.toHaveBeenCalled(); expect(handoffs()).toEqual([]);
    // Fresh operation after explicit refresh/review is recoverable. The result
    // itself never performs a retry or makes a claim about historical calls.
    const refreshed = await f.request(); refreshed.operationId = "fresh-reviewed-operation";
    expect((await f.bridge.handoffManagedChild!(refreshed)).status).toBe("accepted");
    expect(handoffs()).toHaveLength(1);
  });
  it("keeps a synchronous facade exception unknown even when no native transport call can be observed", async () => {
    const f = fixture(), request = await f.request();
    const submit = vi.fn(() => { throw new Error("Synthetic synchronous submission failure"); });
    f.facade.handoffCostApproval = submit;
    await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow("synchronous submission failure");
    expect(submit).toHaveBeenCalledOnce(); expect(handoffs()).toEqual([]);
    await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow("already submitted");
    expect(submit).toHaveBeenCalledOnce();
  });
  it("rejects a successful command response without a proven successor instead of reporting accepted or retrying", async () => {
    const f = fixture(), request = await f.request(); f.omitSuccessor();
    await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow("outcome is unknown");
    await f.bridge.drain(); await f.bridge.conversation("root"); expect(handoffs()).toHaveLength(1);
  });
  it.each(["missing-successor", "missing-reverse", "wrong-request", "wrong-operation"] as const)("requires a current bidirectional successor proof (%s)", async corruption => {
    const f = fixture(), request = await f.request();
    f.facade.leaderBranches = async () => f.branches().filter(b => corruption !== "missing-successor" || !b.handoffFrom).map(b => {
      if (!b.handoffFrom) return b;
      if (corruption === "missing-reverse") return { ...b, handoffFrom: undefined };
      return { ...b, handoffFrom: { ...b.handoffFrom, ...(corruption === "wrong-request" ? { requestId: "different-request" } : {}),
        ...(corruption === "wrong-operation" ? { operationId: "different-operation" } : {}) } };
    });
    await expect(f.bridge.handoffManagedChild!(request)).rejects.toThrow("outcome is unknown");
    expect(handoffs()).toHaveLength(1);
  });
  it("projects A → B → C links independently and only settles after C settles", async () => {
    const f = fixture(), request = await f.request(); await f.bridge.handoffManagedChild!(request);
    const [a, b] = f.branches();
    const link = { branchId: "branch-c", requestId: "approval-b", operationId: "operation-b", payloadFingerprint: "private-fingerprint-b" };
    f.publish([a, { ...b, state: "handed_off", handoffTo: link }, { ...b, id: "branch-c", sessionId: "child-c", state: "running", handoffFrom: { ...link, branchId: b.id } }]);
    const running = await f.bridge.conversation("root"); expect(running.status).toBe("running");
    expect(running.children.map(c => [c.id, c.handoffFrom?.operationId, c.handoffTo?.operationId])).toEqual([
      [a.id, undefined, "operation-a"], [b.id, "operation-a", "operation-b"], ["branch-c", "operation-b", undefined],
    ]);
    expect(running.children[0].handoffTo?.requestId).toBe("approval-a");
    expect(running.children[1].handoffFrom?.requestId).toBe("approval-a");
    expect(running.children[1].handoffTo?.requestId).toBe("approval-b");
    expect(running.children[2].handoffFrom?.requestId).toBe("approval-b");
    f.publish(f.branches().map(b => b.id === "branch-c" ? { ...b, state: "completed" } : b));
    expect((await f.bridge.conversation("root")).status).toBe("idle");
  });
});
