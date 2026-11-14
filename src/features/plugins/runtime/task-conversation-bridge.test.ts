import { describe, expect, it, vi } from "vitest";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import type { EngineEventPayload } from "@/lib/events";
import { TaskPreSpawnError, type HostTaskFacade } from "./task-facade";
import type { HostTaskCostApproval } from "@ccgui/plugin-sdk";

function fixture(saved = new Map<string, unknown>(), cost?: { read: () => any[]; confirm: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> }, prediction?: { read: () => { id: number; text: string } | null; dismiss: ReturnType<typeof vi.fn> }, engine = "codex") {
  const ref = { engine, sessionId: "native-one", workspacePath: "G:/project" };
  let callback = () => {};
  let events = (_events: EngineEventPayload[]) => {};
  const branches: Awaited<ReturnType<HostTaskFacade["leaderBranches"]>> = [];
  const proofs = new Map<string, { status: "completed" | "failed" | "cancelled" }>();
  const state = { messages: [{ seq: 1, role: "user", text: "initial", ts: null as string | null }], runId: null as string | null, status: "idle" as "idle" | "busy", canDeliver: true };
  const facade = { ready: async () => {}, known: () => true, openBackground: async () => {},
    fixedInstructionsSupported: vi.fn(async (_engine?: string) => true), codexServiceTierOverrideSupported: vi.fn(async () => true),
    conversationState: () => state, leaderBranches: async () => branches,
    listen: async (cb: typeof events) => { events = cb; return () => {}; },
    interrupt: vi.fn(async () => true), stopChild: vi.fn(async () => {}), focus: vi.fn(async () => {}),
    conversationAction: vi.fn(async () => {}),
    subscribe: (cb: () => void) => { callback = cb; return () => {}; },
    continueMessage: vi.fn(async (_ref, _text, _images, runId, fence) => { await fence("turn", runId); state.runId = runId; state.status = "busy"; state.canDeliver = false; return { delivery: "turn", runId }; }),
    settledRun: (runId: string) => proofs.get(runId) ?? null, liveRun: (runId: string) => state.runId === runId ? "codex/native-one" : null,
    recoverSettledRun: vi.fn(async (_runId: string, _ref: unknown): Promise<{ status: "completed" } | null> => null),
  };
  const deps = { pluginId: "test", storage: { get: async (_p: string, k: string) => saved.get(k), set: async (_p: string, k: string, v: unknown) => { saved.set(k, structuredClone(v)); }, delete: async () => {} },
    owned: vi.fn(async (id: string) => { if (id !== "root") throw new Error("Unknown owned task"); return { receipt: { requestId: id, workspacePath: ref.workspacePath, session: ref, status: "completed" }, proven: true }; }),
    facade: async () => facade, resolveImages: async (ids: string[]) => ids, now: () => 100, runId: () => "follow-run", hold: vi.fn(),
  };
  if (cost) {
    Object.assign(facade, { costApprovals: () => ({ items: structuredClone(cost.read()), truncated: false }), resolveCostApproval: cost.resolve });
    Object.assign(deps, { confirmCostReview: cost.confirm });
  }
  if (prediction) Object.assign(facade, { composerPrediction: prediction.read, dismissComposerPrediction: prediction.dismiss });
  const bridge = createTaskConversationBridge(deps as never);
  return { bridge, saved, facade, state, branches, proofs, deps, ref, events: (value: EngineEventPayload[]) => events(value), notify: () => callback() };
}
const message = { conversationRequestId: "root", requestId: "input-one", expectedInputRevision: 0, prompt: "continue" };
describe("archived coordinator lifecycle", () => {
  it.each([false, true])("deduplicates closed queued-source loading and rechecks liveness afterwards (changed=%s)", async changed => {
    const original = fixture(); original.state.canDeliver = false;
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(); f.bridge.restore(cut);
    const loading = Promise.withResolvers<void>(); let opened = false;
    const observation = { archived: false, idle: true, isCurrent: () => true };
    const observe = vi.fn(async () => observation).mockResolvedValueOnce(observation);
    if (changed) observe.mockImplementation(async () => ({ ...observation, archived: true }));
    Object.assign(f.facade, {
      conversationState: () => opened ? f.state : null,
      observeLifecycle: observe,
      openBackground: vi.fn(async () => { await loading.promise; opened = true; }),
    });
    try {
      await f.bridge.ready(); await f.bridge.drain();
      await vi.waitFor(() => expect(f.facade.openBackground).toHaveBeenCalledTimes(1));
      await f.bridge.drain(); expect(f.facade.openBackground).toHaveBeenCalledTimes(1);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      loading.resolve();
      if (changed) {
        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
        await f.bridge.drain();
        expect(f.facade.continueMessage).not.toHaveBeenCalled();
        expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
      } else {
        await vi.waitFor(() => expect(f.facade.continueMessage).toHaveBeenCalledTimes(1));
        await f.bridge.drain(); expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
      }
    } finally { loading.resolve(); f.bridge.dispose(); }
  });
  function archived(stopping: boolean) {
    const f = fixture(undefined, undefined, undefined, stopping ? "claude" : "agy");
    const input = (id: string, revision: number, status: string, runId: string, resolved = false) => ({
      receipt: { requestId: id, conversationRequestId: "root", inputRevision: revision, status, delivery: "turn", runId,
        sessionRef: f.ref, acceptedAt: 1, updatedAt: 2, ...(resolved ? { stopResolved: true } : {}) },
      fingerprint: JSON.stringify(["root", id, revision - 1, "fixture", []]), prompt: "fixture", images: [],
    });
    f.bridge.restore({ version: 1, records: [{ requestId: "root", revision: 1, inputRevision: stopping ? 1 : 2,
      sessionRef: f.ref, stopping, stopped: false, stopEpoch: stopping ? 1 : 2, children: [],
      ...(stopping ? { stopRunId: "stop-run", stopInputRevision: 1, stopTerminalProof: { runId: "stop-run", sessionRef: f.ref, status: "completed" } } : {}),
      inputs: stopping ? [input("done", 1, "completed", "stop-run")] : [input("old-unknown", 1, "unknown", "older-run", true), input("latest", 2, "completed", "latest-run")],
    }] });
    if (!stopping) f.deps.owned.mockResolvedValue({ receipt: { requestId: "root", workspacePath: f.ref.workspacePath, session: f.ref,
      status: "failed", error: "Original GUI turn was interrupted" }, proven: true } as never);
    let current = true;
    const observe = vi.fn(async () => ({ archived: true, idle: true, isCurrent: () => current }));
    Object.assign(f.facade, { conversationState: () => null, canProjectTerminalRun: () => false, observeLifecycle: observe,
      openBackground: vi.fn(async () => { throw new Error("Archived source must not be opened"); }) });
    return { ...f, observe, invalidate: () => { current = false; } };
  }
  it.each([true, false])("releases only the current write hold of an archived coordinator (stopping=%s)", async stopping => {
    const f = archived(stopping);
    try {
      const view = await f.bridge.conversation("root");
      expect(view).toMatchObject({ status: stopping ? "cancelled" : "idle", canSend: false, canChangeSelection: false, stopRequested: stopping });
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", false, expect.any(Function));
      expect(f.bridge.capture().records[0].stopping).toBe(stopping);
      if (!stopping) expect(view.deliveries[0]).toMatchObject({ status: "unknown", stopResolved: true });
      await expect(f.bridge.sendMessage({ ...message, expectedInputRevision: view.inputRevision })).rejects.toThrow("cannot accept");
      expect(f.facade.openBackground).not.toHaveBeenCalled();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it.each(["active", "probe-failed", "unresolved-input", "starting-input", "child-unknown", "child-query-failed"])("retains the write hold for %s", async condition => {
    const f = archived(false);
    if (condition === "active") f.observe.mockResolvedValue({ archived: true, idle: false, isCurrent: () => true });
    if (condition === "probe-failed") f.observe.mockRejectedValue(new Error("unavailable"));
    if (condition === "unresolved-input" || condition === "starting-input") {
      const cut = f.bridge.capture(); delete cut.records[0].inputs[0].receipt.stopResolved;
      if (condition === "starting-input") cut.records[0].inputs[0].receipt.status = "starting";
      f.bridge.restore(cut);
    }
    if (condition === "child-unknown") f.branches.push({ id: "late", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
      engine: "codex", sessionId: "child", workspacePath: f.ref.workspacePath, state: "unknown" });
    if (condition === "child-query-failed") f.facade.leaderBranches = async () => { throw new Error("snapshot unavailable"); };
    try {
      const view = await f.bridge.conversation("root");
      expect(view).toMatchObject({ status: "unknown", canSend: false });
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("does not stall other reconciliation while native lifecycle discovery is pending", async () => {
    const f = archived(true), pending = Promise.withResolvers<Awaited<ReturnType<typeof f.observe>>>();
    f.observe.mockReturnValueOnce(pending.promise);
    try {
      await f.bridge.ready(); await f.bridge.drain();
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
      expect(f.observe).toHaveBeenCalledTimes(1);
      await f.bridge.drain(); expect(f.observe).toHaveBeenCalledTimes(1);
      pending.resolve({ archived: true, idle: true, isCurrent: () => true });
      await vi.waitFor(() => expect(f.deps.hold).toHaveBeenLastCalledWith("root", false, expect.any(Function)));
      expect(f.facade.openBackground).not.toHaveBeenCalled();
    } finally { pending.resolve({ archived: true, idle: false, isCurrent: () => false }); f.bridge.dispose(); }
  });
  it("reads archived history without a tab, caches it only for the unchanged observation, and never enables sending", async () => {
    const f = archived(false), loadPage = vi.fn(async () => ({ messages: [{ seq: 1, role: "assistant" as const, text: "saved fixture", ts: null }], nextBefore: null }));
    Object.assign(f.facade, { loadPage });
    try {
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "idle", canSend: false, messages: [{ text: "saved fixture" }] });
      await f.bridge.conversation("root");
      expect(loadPage).toHaveBeenCalledTimes(1);
      expect(f.facade.openBackground).not.toHaveBeenCalled();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("reports archived history failure without undoing independent idle evidence or pretending an empty history succeeded", async () => {
    const f = archived(false), loadPage = vi.fn().mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValue({ messages: [{ seq: 1, role: "assistant", text: "original history retained", ts: null }], nextBefore: null });
    Object.assign(f.facade, { loadPage });
    try {
      const failedRead = await f.bridge.conversation("root");
      expect(failedRead).toMatchObject({ status: "idle", canSend: false, messages: [], error: expect.any(String) });
      expect(failedRead.error).toMatch(/archived|归档/i);
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", false, expect.any(Function));
      const retried = await f.bridge.conversation("root");
      expect(retried).toMatchObject({ status: "idle", canSend: false, messages: [{ text: "original history retained" }] });
      expect(retried.error).toBeUndefined();
      expect(f.facade.openBackground).not.toHaveBeenCalled();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("invalidates a lifecycle release when archive/history ownership changes during read-only history loading", async () => {
    const f = archived(true), page = Promise.withResolvers<{ messages: never[]; nextBefore: null }>();
    Object.assign(f.facade, { loadPage: vi.fn(() => page.promise) });
    try {
      const viewing = f.bridge.conversation("root");
      await vi.waitFor(() => expect((f.facade as unknown as HostTaskFacade).loadPage).toHaveBeenCalledOnce());
      f.invalidate(); page.resolve({ messages: [], nextBefore: null });
      expect(await viewing).toMatchObject({ status: "unknown", canSend: false });
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { page.resolve({ messages: [], nextBefore: null }); f.bridge.dispose(); }
  });
  it("reacquires the hold when evidence changes during release and when a late child appears", async () => {
    const f = archived(true);
    f.deps.hold.mockImplementation((_id, holding) => { if (!holding) f.invalidate(); });
    try {
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
      f.deps.hold.mockReset(); f.observe.mockResolvedValue({ archived: true, idle: true, isCurrent: () => true });
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "cancelled", canSend: false });
      f.branches.push({ id: "late", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
        engine: "codex", sessionId: "late-child", workspacePath: f.ref.workspacePath, state: "running" });
      await f.bridge.drain();
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
});
describe("AGY fixed instruction migration", () => {
  it("adds the first profile only at a full turn and never replays an unproven run after recovery", async () => {
    const f = fixture(undefined, undefined, undefined, "agy");
    const profile = { version: "first", text: "中文😀 original policy" };
    f.state.status = "busy"; f.state.runId = "old-profileless-run";
    await f.bridge.sendMessage({ ...message, fixedInstructions: profile }); await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.capture().records[0].fixedInstructions).toBeUndefined();
    f.state.status = "idle"; f.state.runId = null;
    await f.bridge.drain();
    expect(f.facade.fixedInstructionsSupported).toHaveBeenCalledWith("agy");
    expect(f.facade.continueMessage.mock.calls[0][1]).toBe(message.prompt);
    expect(f.bridge.capture().records[0].fixedInstructions).toEqual(profile);
    f.bridge.dispose();
    const cold = fixture(f.saved, undefined, undefined, "agy");
    await cold.bridge.ready(); await cold.bridge.drain();
    expect(cold.bridge.capture().records[0].fixedInstructions).toEqual(profile);
    expect(cold.facade.continueMessage).not.toHaveBeenCalled();
    cold.bridge.dispose();
  });
  it("rejects AGY on a legacy host even when its global capability is true", async () => {
    const f = fixture(undefined, undefined, undefined, "agy");
    f.facade.fixedInstructionsSupported.mockImplementation(async engine => engine !== "agy");
    await expect(f.bridge.sendMessage({ ...message, fixedInstructions: { version: "v1", text: "policy" } })).rejects.toThrow("unavailable");
    expect(f.facade.continueMessage).not.toHaveBeenCalled(); f.bridge.dispose();
  });
  it("does not send inherited AGY instructions through a legacy host", async () => {
    const f = fixture(undefined, undefined, undefined, "agy");
    const owned = await f.deps.owned("root");
    f.deps.owned.mockResolvedValue({ ...owned, fixedInstructions: { version: "v1", text: "policy" } } as never);
    f.facade.fixedInstructionsSupported.mockImplementation(async engine => engine !== "agy");
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.error).toContain("unavailable");
    f.bridge.dispose();
  });
});
describe("owned coordinator full-history Handoff", () => {
  function summaryFixture() {
    const f = fixture();
    const summarize = vi.fn(async (_ref: typeof f.ref, _selection: unknown, _childContext?: string, _onProgress?: (event: { phase: "reading" }) => void) => "Complete native history summary");
    const version = vi.fn(() => "history-v1");
    const supported = vi.fn(async () => true);
    Object.assign(f.facade, { summarizeHandoff: summarize, fullHistoryHandoffSupported: supported, costContextVersion: version });
    const source = async () => ({ kind: "coordinator" as const, conversationRequestId: "root", expectedRevision: (await f.bridge.conversation("root")).revision });
    return { ...f, summarize, version, supported, source };
  }
  const selection = { engine: "codex" as const, model: "independent-compressor", effort: "high" };
  it("forwards coordinator progress only through the verified native facade", async () => {
    const f = summaryFixture(), progress = vi.fn();
    f.summarize.mockImplementation(async (_ref, _selection, _children, onProgress) => {
      onProgress?.({ phase: "reading" }); return "Complete native history summary";
    });
    try {
      await f.bridge.summarizeCoordinatorHandoff(await f.source(), selection, progress);
      expect(progress).toHaveBeenCalledExactlyOnceWith({ phase: "reading" });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("retains bounded verified child reports alongside full coordinator history", async () => {
    const f = summaryFixture();
    f.branches.push({ id: "child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
      parentWorkspacePath: f.ref.workspacePath, engine: "codex", sessionId: "child-session", workspacePath: f.ref.workspacePath,
      state: "completed", title: "child", delegation: { state: "completed", result: "UNVERIFIED_CHILD_RESULT 中文😀".repeat(400) } } as never);
    try {
      await f.bridge.summarizeCoordinatorHandoff(await f.source(), selection);
      const context = f.summarize.mock.calls[0][2]!;
      expect(context).toContain("UNVERIFIED_CHILD_RESULT"); expect(context).toContain("不代表独立验收");
      expect(context.length).toBeLessThanOrEqual(6000); expect(context).not.toMatch(/[\uD800-\uDBFF]$/);
    } finally { f.bridge.dispose(); }
  });
  it.each(["agy", "codex"])("summarizes an idle %s source through the full facade with an independent compressor", async engine => {
    const f = summaryFixture(); f.ref.engine = engine;
    try {
      const source = await f.source(), before = f.bridge.capture();
      expect(await f.bridge.summarizeCoordinatorHandoff(source, selection)).toBe("Complete native history summary");
      expect(f.summarize).toHaveBeenCalledExactlyOnceWith(f.ref, selection);
      expect(f.bridge.capture()).toEqual(before);
      expect(f.facade.continueMessage).not.toHaveBeenCalled(); expect(f.facade.conversationAction).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it.each(["foreign", "stale", "legacy", "unproven", "workspace", "receipt-unknown", "paused", "stopping", "ownership-error", "native-busy", "permission", "child", "child-unknown", "held-delegation", "queued", "unresolved"])("rejects %s sources before compression", async kind => {
    const f = summaryFixture();
    try {
      let source = await f.source();
      if (kind === "foreign") source.conversationRequestId = "other-plugin-root";
      if (kind === "stale") source.expectedRevision++;
      if (kind === "legacy") f.supported.mockResolvedValue(false);
      if (["unproven", "workspace", "receipt-unknown"].includes(kind)) {
        const owner = await f.deps.owned("root");
        if (kind === "unproven") owner.proven = false;
        if (kind === "workspace") owner.receipt = { ...owner.receipt, session: { ...owner.receipt.session, workspacePath: "G:/other" } };
        if (kind === "receipt-unknown") owner.receipt.status = "unknown";
        f.deps.owned.mockResolvedValue(owner);
      }
      if (kind === "paused") Object.assign(f.deps, { paused: () => true });
      if (kind === "stopping" || kind === "ownership-error") {
        const saved = f.bridge.capture();
        if (kind === "stopping") saved.records[0].stopping = true;
        else saved.records[0].ownershipError = "Owner proof failed";
        f.bridge.restore(saved);
      }
      if (kind === "native-busy") f.state.status = "busy";
      if (kind === "permission") Object.assign(f.state, { status: "awaiting_permission" });
      if (["child", "child-unknown", "held-delegation"].includes(kind)) f.branches.push({ id: "child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
        parentWorkspacePath: f.ref.workspacePath, engine: "codex", sessionId: "child-session", workspacePath: f.ref.workspacePath,
        state: kind === "child" ? "running" : kind === "child-unknown" ? "unknown" : "completed", title: "child",
        ...(kind === "held-delegation" ? { delegation: { requestId: "held", state: "awaiting_cost_approval" } } : {}) } as never);
      if (kind === "queued" || kind === "unresolved") {
        f.state.canDeliver = false;
        await f.bridge.sendMessage(message); await f.bridge.drain();
        if (kind === "unresolved") { const saved = f.bridge.capture(); saved.records[0].inputs[0].receipt.status = "unknown"; f.bridge.restore(saved); }
      }
      // Use the current revision for state tests: failure must be a safety
      // boundary, not merely a stale revision left by the setup.
      if (!["foreign", "stale", "unproven", "workspace", "stopping", "ownership-error"].includes(kind)) source = await f.source();
      await expect(f.bridge.summarizeCoordinatorHandoff(source, selection)).rejects.toThrow();
      expect(f.summarize).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it.each(["history", "revision", "session", "workspace", "owner", "paused", "busy", "permission", "child", "input", "disposed"])("rejects %s changes during compression", async kind => {
    const f = summaryFixture(), gate = deferred<string>(); f.summarize.mockReturnValue(gate.promise);
    try {
      const flight = f.bridge.summarizeCoordinatorHandoff(await f.source(), selection);
      const rejected = expect(flight).rejects.toThrow();
      await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledOnce());
      if (kind === "history") f.version.mockReturnValue("history-v2");
      if (kind === "revision") f.state.messages.push({ seq: 2, role: "assistant", text: "New saved content", ts: null });
      if (kind === "session") f.ref.sessionId = "replacement";
      if (kind === "workspace") f.ref.workspacePath = "G:/other";
      if (kind === "owner") { const owner = await f.deps.owned("root"); owner.proven = false; f.deps.owned.mockResolvedValue(owner); }
      if (kind === "paused") Object.assign(f.deps, { paused: () => true });
      if (kind === "busy") f.state.status = "busy";
      if (kind === "permission") Object.assign(f.state, { status: "awaiting_permission" });
      if (kind === "child") f.branches.push({ id: "child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
        parentWorkspacePath: f.ref.workspacePath, engine: "codex", sessionId: "child-session", workspacePath: f.ref.workspacePath, state: "running", title: "child" });
      if (kind === "input") { f.state.canDeliver = false; await f.bridge.sendMessage(message); await f.bridge.drain(); }
      if (kind === "disposed") f.bridge.dispose();
      gate.resolve("Stale result"); await rejected;
      expect(f.summarize).toHaveBeenCalledTimes(1); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it.each(["native", "owner", "history", "child-notification"])("rechecks %s after projection yields before submitting", async kind => {
    const f = summaryFixture();
    try {
      const source = await f.source();
      f.deps.hold.mockImplementationOnce(async () => {
        if (kind === "native") f.state.status = "busy";
        if (kind === "owner") { const owner = await f.deps.owned("root"); owner.proven = false; f.deps.owned.mockResolvedValue(owner); }
        if (kind === "history") f.version.mockReturnValue("history-v2");
        if (kind === "child-notification") f.notify();
      });
      await expect(f.bridge.summarizeCoordinatorHandoff(source, selection)).rejects.toThrow();
      expect(f.summarize).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
});
it("projects and continues an AGY coordinator without inventing a separate effort", async () => {
  const f = fixture(); f.ref.engine = "agy";
  Object.assign(f.facade, { conversationLaunch: () => ({ model: "gemini-4-argon-high", defaultEffort: "high", providerId: "agy-channel" }) });
  try {
    const view = await f.bridge.conversation("root");
    expect(view.selection).toEqual({ engine: "agy", model: "gemini-4-argon-high", providerId: "agy-channel" });
    expect(view.effectiveSelection).toEqual(view.selection);
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    expect(f.facade.continueMessage.mock.calls[0][0]).toEqual(f.ref);
  } finally { f.bridge.dispose(); }
});
it("projects the native idle state separately from a queued coordinator input", async () => {
  const f = fixture(); f.state.canDeliver = false;
  try {
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "running", nativeStatus: "idle", canChangeSelection: false });
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
  } finally { f.bridge.dispose(); }
});
it("projects native activity separately while a managed child is still running", async () => {
  const f = fixture();
  f.branches.push({ id: "child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
    parentWorkspacePath: f.ref.workspacePath, engine: "codex", sessionId: "child-session", workspacePath: f.ref.workspacePath, state: "running", title: "child" });
  try {
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "running", nativeStatus: "idle" });
    f.state.status = "busy";
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "running", nativeStatus: "busy" });
  } finally { f.bridge.dispose(); }
});
it("does not substitute the initial selection when the current native selection is incomplete", async () => {
  const f = fixture();
  const owned = await f.deps.owned("root");
  const original = { engine: "codex", model: "old-model", effort: "max", providerId: "old-channel" };
  Object.assign(owned.receipt, { requestedSelection: original, effectiveSelection: original });
  f.deps.owned.mockResolvedValue(owned);
  Object.assign(f.facade, { conversationLaunch: () => ({ model: "new-model", effort: "xhigh", defaultProvider: null }) });
  try {
    const view = await f.bridge.conversation("root");
    expect(view.selection).toBeUndefined(); expect(view.effectiveSelection).toBeUndefined();
    expect(owned.receipt).toMatchObject({ requestedSelection: original, effectiveSelection: original });
  } finally { f.bridge.dispose(); }
});
it("never resolves host-managed task image references through the plugin image resolver", async () => {
  const f = fixture(), resolve = vi.fn(async (ids: string[]) => ids); f.deps.resolveImages = resolve;
  try {
    await expect(f.bridge.sendMessage({ ...message, images: [`task-image:${"a".repeat(64)}`] })).rejects.toThrow("Invalid continuation");
    expect(resolve).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
  } finally { f.bridge.dispose(); }
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function contextFixture(count = 1) {
  const rows: HostTaskCostApproval[] = [];
  const fullMessages = new Map<string, string>();
  const confirm = vi.fn(async () => true);
  const resolve = vi.fn(async (_refs: unknown, expected: HostTaskCostApproval) => {
    const at = rows.findIndex(row => row.requestId === expected.requestId); if (at >= 0) rows.splice(at, 1);
  });
  const f = fixture(undefined, { read: () => rows, confirm, resolve });
  for (let i = 0; i < count; i++) rows.push({ kind: "leader", id: `leader:child-${i}`, requestId: `held-${i}`,
    sender: f.ref, target: { engine: "agy", sessionId: `unopened-child-${i}`, workspacePath: "G:/child" },
    message: "pending message", truncated: false, model: "gemini", cacheHeat: "unknown", usageKind: "unknown", capturedAt: 10, canHandoff: true });
  const load = vi.fn<NonNullable<HostTaskFacade["loadCostApprovalContext"]>>(async () => null);
  const version = vi.fn<NonNullable<HostTaskFacade["costContextVersion"]>>(() => "metadata-0");
  const capture = vi.fn((_refs: unknown, expected: HostTaskCostApproval) => {
    const row = rows.find(row => row.id === expected.id && row.requestId === expected.requestId);
    if (!row) throw new Error("No longer pending");
    return { approval: structuredClone(row), message: fullMessages.get(row.requestId) ?? row.message, kind: "leader" as const };
  });
  const open = vi.fn(async (_ref: typeof f.ref) => {});
  Object.assign(f.facade, { captureCostApproval: capture, loadCostApprovalContext: load, costContextVersion: version, openBackground: open });
  return { ...f, rows, fullMessages, load, version, capture, confirm, resolve, open };
}
const withContext = (approval: HostTaskCostApproval, used = 353093): HostTaskCostApproval => ({ ...structuredClone(approval),
  used, max: 1000000, usageKind: "last_request", contextReference: false, modelMismatch: false, usageModel: "gemini" });

describe("background held-task context projection", () => {
  it("automatically retries a missing metadata result once exact metadata becomes available", async () => {
    const f = contextFixture();
    let metadata: { filePath: string; fileMtimeMs: number } | null = null;
    f.version.mockImplementation(() => JSON.stringify(metadata));
    f.load.mockImplementation(async (_refs, approval) => metadata ? withContext(approval) : null);
    try {
      await f.bridge.conversation("root"); await f.bridge.drain();
      f.notify(); await f.bridge.drain(); expect(f.load).toHaveBeenCalledOnce();
      metadata = { filePath: "/saved/child.db", fileMtimeMs: 123 };
      f.notify();
      await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBe(353093));
      f.notify(); await f.bridge.drain(); expect(f.load).toHaveBeenCalledTimes(2);
      expect(f.resolve).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("discards an old source result even when metadata changes before any new projection", async () => {
    const f = contextFixture(), old = deferred<HostTaskCostApproval | null>(), current = deferred<HostTaskCostApproval | null>();
    f.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const observed: Array<number | undefined> = [];
    try {
      await f.bridge.conversation("root");
      f.bridge.onConversationEvent(view => { observed.push(view.costApprovals?.[0]?.used); });
      // No notify/project between the source update and completion: the final
      // validation itself must reject the obsolete metadata version.
      f.version.mockReturnValue("metadata-1");
      old.resolve(withContext(f.rows[0], 111));
      await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
      expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBeUndefined();
      expect(observed).not.toContain(111);
      current.resolve(withContext(f.rows[0], 222));
      await vi.waitFor(async () => expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBe(222));
      expect(f.load).toHaveBeenCalledTimes(2);
    } finally { old.resolve(null); current.resolve(null); f.bridge.dispose(); }
  });
  it("reads an unopened child without blocking inspection and only merges context fields", async () => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>();
    f.load.mockReturnValue(gate.promise);
    try {
      const first = await f.bridge.conversation("root");
      expect(first.costApprovals?.[0].used).toBeUndefined();
      expect(f.load).toHaveBeenCalledOnce();
      expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBeUndefined();
      const result = withContext(f.rows[0]);
      result.cacheHeat = "hot"; result.capturedAt = 999; result.canHandoff = false;
      gate.resolve(result);
      await vi.waitFor(async () => expect((await f.bridge.conversation("root")).costApprovals?.[0]).toMatchObject({
        used: 353093, max: 1000000, usageKind: "last_request", cacheHeat: "unknown", capturedAt: 10, canHandoff: true,
      }));
      expect(f.rows[0].used).toBeUndefined();
      expect(f.open.mock.calls.every(([ref]) => (ref as any).sessionId === f.ref.sessionId)).toBe(true);
      expect(f.resolve).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
      expect(f.load).toHaveBeenCalledOnce();
    } finally { gate.resolve(null); f.bridge.dispose(); }
  });
  it("lets a human cancel while history is unresolved and discards the late sample", async () => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>(), original = structuredClone(f.rows[0]);
    f.load.mockReturnValue(gate.promise);
    try {
      const view = await f.bridge.conversation("root");
      await f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: original.id, approvalRequestId: original.requestId, decision: "cancel" });
      expect(f.resolve).toHaveBeenCalledOnce();
      gate.resolve(withContext(original));
      expect((await f.bridge.conversation("root")).costApprovals).toEqual([]);
      await f.bridge.drain();
      expect((await f.bridge.conversation("root")).costApprovals).toEqual([]);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { gate.resolve(null); f.bridge.dispose(); }
  });
  it.each(["target", "request", "model", "messageTail", "sender"] as const)("discards a late result after the %s changes", async change => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>(), original = structuredClone(f.rows[0]);
    f.load.mockReturnValueOnce(gate.promise).mockResolvedValue(null);
    try {
      await f.bridge.conversation("root");
      if (change === "target") f.rows[0].target = { ...f.rows[0].target, sessionId: "replacement" };
      if (change === "request") f.rows[0].requestId = "replacement";
      if (change === "model") f.rows[0].model = "other-model";
      if (change === "messageTail") f.fullMessages.set(original.requestId, "pending message plus an undisplayed tail");
      if (change === "sender") f.rows[0].sender = { ...f.ref, sessionId: "unowned" };
      gate.resolve(withContext(original));
      await f.bridge.drain();
      expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBeUndefined();
      await f.bridge.drain();
      expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBeUndefined();
      expect(f.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve(null); f.bridge.dispose(); }
  });
  it("never replaces more trustworthy loaded telemetry with a pending history sample", async () => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>(), original = structuredClone(f.rows[0]);
    f.load.mockReturnValue(gate.promise);
    try {
      await f.bridge.conversation("root");
      Object.assign(f.rows[0], { used: 42000, max: 200000, usageKind: "current_context" });
      gate.resolve(withContext(original));
      await vi.waitFor(async () => expect((await f.bridge.conversation("root")).costApprovals?.[0]).toMatchObject({ used: 42000, max: 200000, usageKind: "current_context" }));
      expect(f.load).toHaveBeenCalledOnce();
    } finally { gate.resolve(null); f.bridge.dispose(); }
  });
  it("clears unknown projection capacity and attribution omitted by the new context sample", async () => {
    const f = contextFixture();
    Object.assign(f.rows[0], { max: 999999, contextReference: true, modelMismatch: true, usageModel: "old-model" });
    f.load.mockImplementation(async (_refs, expected) => {
      const { max: _max, contextReference: _reference, modelMismatch: _mismatch, usageModel: _model, ...base } = expected;
      return { ...base, used: 80000, usageKind: "last_request" };
    });
    try {
      await f.bridge.conversation("root");
      await vi.waitFor(async () => {
        const approval = (await f.bridge.conversation("root")).costApprovals?.[0];
        expect(approval?.used).toBe(80000);
        expect(approval?.max).toBeUndefined(); expect(approval?.contextReference).toBeUndefined();
        expect(approval?.modelMismatch).toBeUndefined(); expect(approval?.usageModel).toBeUndefined();
      });
    } finally { f.bridge.dispose(); }
  });
  it("limits concurrent reads and services the remaining distinct requests after a slot is released", async () => {
    const f = contextFixture(6), gates = Array.from({ length: 6 }, () => deferred<HostTaskCostApproval | null>());
    f.load.mockImplementation(async (_refs, approval) => gates[Number(approval.requestId.slice(5))].promise);
    try {
      await f.bridge.conversation("root");
      expect(f.load).toHaveBeenCalledTimes(4);
      await f.bridge.conversation("root"); expect(f.load).toHaveBeenCalledTimes(4);
      gates[1].resolve(withContext(f.rows[1], 222));
      await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(5));
      gates[3].resolve(null);
      await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(6));
      gates.forEach((gate, i) => gate.resolve(withContext(f.rows[i], i + 100)));
      await vi.waitFor(async () => {
        const view = await f.bridge.conversation("root");
        expect(view.costApprovals?.[1].used).toBe(222);
        expect(view.costApprovals?.[5].used).toBe(105);
      });
      await f.bridge.drain(); expect(f.load).toHaveBeenCalledTimes(6);
    } finally { gates.forEach(gate => gate.resolve(null)); f.bridge.dispose(); }
  });
  it.each(["empty", "error"])("memoizes %s reads instead of retrying on each wake", async outcome => {
    const f = contextFixture();
    if (outcome === "error") f.load.mockRejectedValue(new Error("history unavailable"));
    try {
      await f.bridge.conversation("root"); await f.bridge.drain();
      f.notify(); await f.bridge.drain();
      const view = await f.bridge.conversation("root");
      expect(view.costApprovals?.[0].used).toBeUndefined(); expect(view.error).toBeUndefined();
      expect(f.load).toHaveBeenCalledOnce(); expect(f.resolve).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("disposes immediately and never publishes late history", async () => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>(), updates = vi.fn();
    f.load.mockReturnValue(gate.promise);
    await f.bridge.conversation("root");
    f.bridge.onConversationEvent(updates);
    f.bridge.dispose();
    const writes = structuredClone([...f.saved]);
    gate.resolve(withContext(f.rows[0]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(updates).not.toHaveBeenCalled(); expect([...f.saved]).toEqual(writes);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });
  it("rejects a completion after the durable record instance is replaced", async () => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>();
    f.load.mockReturnValueOnce(gate.promise).mockResolvedValue(null);
    try {
      await f.bridge.conversation("root");
      f.bridge.restore(f.bridge.capture());
      gate.resolve(withContext(f.rows[0]));
      await f.bridge.drain();
      expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBeUndefined();
    } finally { gate.resolve(null); f.bridge.dispose(); }
  });
  it("discards a descendant sample after its native ownership edge disappears", async () => {
    const f = contextFixture(), gate = deferred<HostTaskCostApproval | null>();
    const sender = { engine: "claude", sessionId: "intermediate", workspacePath: "G:/child" };
    f.rows[0].sender = sender;
    f.branches.push({ id: "intermediate", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
      parentWorkspacePath: f.ref.workspacePath, ...sender, state: "completed" });
    f.load.mockReturnValue(gate.promise);
    try {
      await f.bridge.conversation("root"); expect(f.load).toHaveBeenCalledOnce();
      expect(f.load).toHaveBeenCalledWith([sender], expect.objectContaining({ requestId: f.rows[0].requestId }));
      f.branches.splice(0);
      gate.resolve(withContext(f.rows[0]));
      await f.bridge.drain();
      expect((await f.bridge.conversation("root")).costApprovals?.[0].used).toBeUndefined();
      expect(f.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve(null); f.bridge.dispose(); }
  });
  it("allows a read-only coordinator handoff preview for advisory cache metadata", async () => {
    const f = fixture();
    Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature: "reference", review: {
      capturedAt: 1, model: "gemini", cacheHeat: "unknown", targetStatus: "idle",
      cache: { startedAt: 1, observedAt: 2, ttlSeconds: 900, source: "agy-gemini-reference", reference: { maxTtlSeconds: 1200, promptTokens: 80000, cacheReadTokens: 0 } },
      context: { used: 80000, kind: "last_request", capacityKnown: false, reference: false, modelMismatch: false },
    } }), inspect: () => "idle" });
    const handoffExcerpt = vi.fn(async () => ({ messages: [], nextBefore: null, truncated: false }));
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true), handoffExcerpt });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      const view = await f.bridge.conversation("root"), approval = view.costApprovals![0];
      expect(approval.canPreviewHandoff).toBe(true); expect(approval.canHandoff).toBe(false);
      await f.bridge.previewCostHandoff!({ conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId });
      expect(handoffExcerpt).toHaveBeenCalledOnce(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
});
describe("owned continuous task conversations", () => {
  it("eventually samples over 64 held approvals across coordinators without retrying stable empty reads", async () => {
    const f = fixture(), roots = [f.ref, { ...f.ref, sessionId: "native-two" }, { ...f.ref, sessionId: "native-three" }];
    const byId = new Map(roots.map((ref, index) => [`root${index || ""}`, ref]));
    const rows = roots.map((ref, index) => Array.from({ length: 22 }, (_, number) => ({
      kind: "leader" as const, id: `approval-${index}-${number}`, requestId: `request-${index}-${number}`, sender: ref,
      target: { engine: "agy", sessionId: `target-${index}-${number}`, workspacePath: ref.workspacePath },
      message: "held", truncated: false, model: "gemini", cacheHeat: "unknown" as const,
      usageKind: "unknown" as const, capturedAt: 1, canHandoff: true,
    })));
    const load = vi.fn(async () => null);
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true), owned: vi.fn(async (id: string) => {
      const ref = byId.get(id); if (!ref) throw new Error("Unknown owned task");
      return { receipt: { requestId: id, workspacePath: ref.workspacePath, session: ref, status: "completed" }, proven: true };
    }) });
    Object.assign(f.facade, { costApprovals: (refs: typeof roots) => ({ items: rows[roots.findIndex(ref => ref.sessionId === refs[0]?.sessionId)] ?? [], truncated: false }),
      captureCostApproval: (_refs: typeof roots, approval: typeof rows[number][number]) => ({ approval, message: approval.message, kind: "leader" }),
      loadCostApprovalContext: load });
    try {
      for (const id of byId.keys()) await f.bridge.conversation(id);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(66), { timeout: 10000 });
      await f.bridge.drain();
      expect(load).toHaveBeenCalledTimes(66);
    } finally { f.bridge.dispose(); }
  });
  it("keeps queued approvals ahead of a changed source and skips a cancelled queued read", async () => {
    const f = fixture(), gates = new Map<string, ReturnType<typeof deferred<null>>>(), versions = new Map<string, string>();
    let approvals = Array.from({ length: 6 }, (_, n) => ({ kind: "leader" as const, id: `cost-${n}`, requestId: `held-${n}`,
      sender: f.ref, target: { engine: "agy", sessionId: `child-${n}`, workspacePath: f.ref.workspacePath },
      message: "held", truncated: false, model: "gemini", cacheHeat: "unknown" as const,
      usageKind: "unknown" as const, capturedAt: 1, canHandoff: true }));
    const started: string[] = [], load = vi.fn(async (_refs: unknown, approval: typeof approvals[number]) => {
      const key = `${approval.id}:${versions.get(approval.id) ?? "v1"}`;
      started.push(key); const gate = deferred<null>(); gates.set(key, gate); return gate.promise;
    });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    Object.assign(f.facade, { costApprovals: () => ({ items: approvals, truncated: false }),
      captureCostApproval: (_refs: unknown, approval: typeof approvals[number]) => ({ approval, message: approval.message, kind: "leader" }),
      costContextVersion: (target: typeof approvals[number]["target"]) => versions.get(target.sessionId.replace("child-", "cost-")) ?? "v1",
      loadCostApprovalContext: load });
    try {
      await f.bridge.conversation("root");
      await vi.waitFor(() => expect(started).toEqual(["cost-0:v1", "cost-1:v1", "cost-2:v1", "cost-3:v1"]));
      versions.set("cost-0", "v2"); approvals = approvals.filter(item => item.id !== "cost-4");
      await f.bridge.conversation("root");
      gates.get("cost-0:v1")!.resolve(null);
      await vi.waitFor(() => expect(started[4]).toBe("cost-5:v1"));
      expect(started).not.toContain("cost-4:v1");
      gates.get("cost-1:v1")!.resolve(null);
      await vi.waitFor(() => expect(started[5]).toBe("cost-0:v2"));
      expect(started).toHaveLength(6);
    } finally { for (const gate of gates.values()) gate.resolve(null); f.bridge.dispose(); }
  });
  it("projects coordinator cost telemetry without inventing GPT cache expiry", async () => {
    const f = fixture();
    Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature: "model-change", review: {
      capturedAt: 123, model: "gpt-6.1-terra", cacheHeat: "cold", cacheExpiryDisabled: true, targetStatus: "idle",
      cache: { startedAt: 1, observedAt: 2, ttlSeconds: 900, source: "agy-vertex-reference",
        reference: { maxTtlSeconds: 1200, cacheReadTokens: 0, promptTokens: 353093 } },
      context: { used: 80000, max: 200000, kind: "last_request", capacityKnown: true, reference: true, modelMismatch: true, usageModel: "previous-model" },
    } }) });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      expect((await f.bridge.conversation("root")).costApprovals![0]).toMatchObject({ kind: "coordinatorInput", cacheExpiryDisabled: true,
        used: 80000, max: 200000, usageKind: "last_request", contextReference: true, modelMismatch: true, usageModel: "previous-model",
        cacheReference: { promptTokens: 353093, cacheReadTokens: 0 } });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it.each(["approve", "cancel"] as const)("rechecks changed displayed usage before a human %s decision", async decision => {
    const approval = { kind: "leader" as const, id: "held-cost", requestId: "held-request", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" },
      target: { engine: "agy", sessionId: "child", workspacePath: "G:/project" }, message: "held", truncated: false, model: "gemini",
      cacheHeat: "unknown" as const, usageKind: "last_request" as const, used: 50000, capturedAt: 1, canHandoff: true };
    const gate = deferred<boolean>(), cost = { read: () => [approval], confirm: vi.fn(() => gate.promise), resolve: vi.fn(async () => {}) };
    const f = fixture(new Map(), cost);
    Object.assign(f.facade, { captureCostApproval: () => ({ approval, message: approval.message, kind: "leader" }) });
    try {
      const view = await f.bridge.conversation("root");
      const pending = f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId, decision });
      await vi.waitFor(() => expect(cost.confirm).toHaveBeenCalledOnce());
      approval.used = 350000; gate.resolve(true);
      if (decision === "approve") { await expect(pending).rejects.toThrow("changed"); expect(cost.resolve).not.toHaveBeenCalled(); }
      else { await pending; expect(cost.resolve).toHaveBeenCalledOnce(); }
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });
  it("retains descendant cost review when a proven child workspace changes only Windows separator spelling", async () => {
    const f = fixture(), sender = { engine: "codex", sessionId: "child-session", workspacePath: "G:/child" };
    const approval = { id: "leader:grandchild", requestId: "held", sender, target: { engine: "agy", sessionId: "gemini", workspacePath: "G:/grandchild" },
      message: "held input", truncated: false, model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 1, canHandoff: true };
    f.branches.push(
      { id: "child", title: "Child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId, parentWorkspacePath: f.ref.workspacePath,
        engine: sender.engine, sessionId: sender.sessionId, workspacePath: "G:\\child", state: "running" },
      { id: "grandchild", title: "Gemini", parentEngine: sender.engine, parentSessionId: sender.sessionId, parentWorkspacePath: "G:\\child",
        engine: approval.target.engine, sessionId: approval.target.sessionId, workspacePath: approval.target.workspacePath, state: "awaiting_cost_approval" },
    );
    Object.assign(f.facade, { costApprovals: (refs: typeof sender[]) => ({ items: refs.some(ref => ref.sessionId === sender.sessionId && ref.workspacePath.replace(/\\/g, "/") === sender.workspacePath) ? [approval] : [], truncated: false }) });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    try {
      expect((await f.bridge.conversation("root")).costApprovals).toEqual([approval]);
      f.branches[0].workspacePath = "G:/child"; f.branches[1].parentWorkspacePath = "G:/child";
      const updated = await f.bridge.conversation("root");
      expect(updated.status).not.toBe("unknown");
      expect(updated.costApprovals).toEqual([approval]);
    } finally { f.bridge.dispose(); }
  });
  it("keeps a proven descendant's held cost request visible even when its execution state is unknown", async () => {
    const f = fixture(), child = { engine: "codex", sessionId: "child-session", workspacePath: "G:/project" };
    const target = { engine: "agy", sessionId: "gemini-session", workspacePath: "G:/project" };
    const approval = { id: "leader:gemini", requestId: "gemini-held", sender: child, target, message: "child follow-up", truncated: false,
      model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 1, canHandoff: true };
    const resolve = vi.fn(async () => {}), confirm = vi.fn(async () => true), gate = deferred<boolean>();
    f.branches.push(
      { id: "child", title: "Child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId, parentWorkspacePath: f.ref.workspacePath,
        ...child, state: "unknown" },
      { id: "gemini", title: "Gemini", parentEngine: child.engine, parentSessionId: child.sessionId, parentWorkspacePath: child.workspacePath,
        ...target, state: "awaiting_cost_approval" },
    );
    Object.assign(f.facade, {
      costApprovals: (refs: typeof child[]) => ({ items: refs.some(ref => ref.engine === child.engine && ref.sessionId === child.sessionId && ref.workspacePath === child.workspacePath) ? [approval] : [], truncated: false }),
      captureCostApproval: () => ({ approval, message: approval.message, kind: "leader" }), resolveCostApproval: resolve,
    });
    Object.assign(f.deps, { confirmCostReview: confirm });
    try {
      const view = await f.bridge.conversation("root");
      expect(view.status).toBe("unknown");
      expect(view.costApprovals).toEqual([approval]);
      await f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" });
      expect(resolve).toHaveBeenCalledWith(expect.arrayContaining([child]), approval, "approve", approval.message);
      // A retained old child without a current ownership edge must not grant
      // authority to a pending request that happens to use that session ID.
      const second = await f.bridge.conversation("root");
      confirm.mockImplementationOnce(() => gate.promise);
      const pending = f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: second.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" });
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
      const [missing] = f.branches.splice(0, 1);
      gate.resolve(true);
      await expect(pending).rejects.toThrow("changed");
      expect(resolve).toHaveBeenCalledTimes(1);
      expect((await f.bridge.conversation("root")).costApprovals).toEqual([]);
      // Native ownership normalizes Windows separators, but preserves case.
      f.branches.unshift({ ...missing, parentWorkspacePath: "g:/PROJECT" });
      expect((await f.bridge.conversation("root")).costApprovals).toEqual([]);
      f.branches[0].parentWorkspacePath = "G:\\project";
      expect((await f.bridge.conversation("root")).costApprovals).toEqual([approval]);
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });
  it("holds a cold coordinator continuation for a human cost decision before starting a native turn", async () => {
    const f = fixture(), confirm = vi.fn(async () => true);
    const evaluation = { required: true, signature: "cold-model-a", review: { capturedAt: 123, model: "model-a", cacheHeat: "cold", targetStatus: "idle", context: { used: 80000, max: 200000, capacityKnown: true, kind: "current_context", reference: false, modelMismatch: false } } };
    Object.assign(f.facade, { sessionCostReview: () => evaluation });
    Object.assign(f.deps, { confirmCostReview: confirm });
    try {
      await f.bridge.sendMessage({ ...message, displayText: "用户续发原文" });
      await f.bridge.drain();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      const view = await f.bridge.conversation("root");
      const approval = view.costApprovals?.find(item => item.requestId === message.requestId);
      expect(approval).toMatchObject({ target: f.ref, message: "用户续发原文", model: "model-a", cacheHeat: "cold" });
      await f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval!.id, approvalRequestId: approval!.requestId, decision: "approve" });
      await f.bridge.drain();
      expect(confirm).toHaveBeenCalledOnce(); expect(f.facade.continueMessage).toHaveBeenCalledOnce();
      expect(await f.bridge.messageReceipt("root", message.requestId)).toMatchObject({ status: "received", requestId: message.requestId });
    } finally { f.bridge.dispose(); }
  });
  it("restores an idle AGY continuation as a cost-held original input and sends only after confirmation", async () => {
    const evaluation = { required: true, signature: "idle-agy-cold", review: { capturedAt: 123, model: "gemini-4-argon-high", cacheHeat: "cold", targetStatus: "idle", context: { used: 100576, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } };
    const saved = new Map<string, unknown>();
    const old = fixture(saved); old.ref.engine = "agy";
    Object.assign(old.facade, { sessionCostReview: () => evaluation });
    Object.assign(old.deps, { confirmCostReview: vi.fn(async () => false) });
    try {
      await old.bridge.sendMessage({ ...message, prompt: "原始上下文\n继续", displayText: "继续" });
      await old.bridge.drain();
      expect(old.facade.continueMessage).not.toHaveBeenCalled();
    } finally { old.bridge.dispose(); }
    const current = fixture(saved); current.ref.engine = "agy";
    const confirm = vi.fn(async () => false);
    Object.assign(current.facade, { sessionCostReview: () => evaluation });
    Object.assign(current.deps, { confirmCostReview: confirm });
    try {
      const view = await current.bridge.conversation("root"), approval = view.costApprovals?.[0];
      expect(view.nativeStatus).toBe("idle");
      expect(view.costApprovals).toHaveLength(1);
      expect(approval).toMatchObject({ kind: "coordinatorInput", requestId: message.requestId, target: current.ref, message: "继续", model: "gemini-4-argon-high" });
      const action = { type: "requestCostReview" as const, conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval!.id, approvalRequestId: approval!.requestId, decision: "approve" as const };
      await current.bridge.conversationAction("root", action);
      await current.bridge.drain();
      expect(current.facade.continueMessage).not.toHaveBeenCalled();
      expect(await current.bridge.messageReceipt("root", message.requestId)).toMatchObject({ requestId: message.requestId, inputRevision: 1, status: "queued" });
      confirm.mockResolvedValueOnce(true);
      const latest = await current.bridge.conversation("root");
      await current.bridge.conversationAction("root", { ...action, expectedRevision: latest.revision });
      await current.bridge.drain();
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(current.facade.continueMessage).toHaveBeenCalledOnce();
      expect(current.facade.continueMessage.mock.calls[0][1]).toBe("原始上下文\n继续");
      expect(await current.bridge.messageReceipt("root", message.requestId)).toMatchObject({ requestId: message.requestId, inputRevision: 1, status: "received" });
      expect(current.bridge.capture().records[0].inputs).toHaveLength(1);
    } finally { current.bridge.dispose(); }
  });
  it("keeps a continuation queued when cost changes during the human confirmation", async () => {
    const f = fixture(), gate = deferred<boolean>(), confirm = vi.fn(() => gate.promise);
    let signature = "model-a";
    Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature, review: { capturedAt: 123, model: signature, cacheHeat: "cold", targetStatus: "idle", context: { used: 80000, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } }) });
    Object.assign(f.deps, { confirmCostReview: confirm });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      const view = await f.bridge.conversation("root"), approval = view.costApprovals![0];
      const action = { type: "requestCostReview" as const, conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" as const };
      const decision = f.bridge.conversationAction("root", action);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      signature = "model-b"; gate.resolve(true);
      await expect(decision).rejects.toThrow("changed"); await f.bridge.drain();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      expect((await f.bridge.conversation("root")).costApprovals?.[0]).toMatchObject({ model: "model-b" });
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });
  it("rechecks cost at the final pre-spawn fence when cache cools during preparation", async () => {
    const f = fixture(), nativeSend = vi.fn(); let cold = false;
    Object.assign(f.facade, { sessionCostReview: () => ({ required: cold, signature: cold ? "cold" : "hot", review: { capturedAt: 123, model: "model-a", cacheHeat: cold ? "cold" : "hot", targetStatus: "idle", context: { used: 80000, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } }) });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    (f.facade.continueMessage as any).mockImplementationOnce(async (_ref: unknown, _text: string, _images: string[], runId: string, fence: any, _launch: unknown, _onRow: unknown, beforeSpawn: () => Promise<void>) => {
      await fence("turn", runId); cold = true; await beforeSpawn(); nativeSend(); return { delivery: "turn", runId };
    });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      expect(nativeSend).not.toHaveBeenCalled();
      expect(await f.bridge.messageReceipt("root", message.requestId)).toMatchObject({ status: "queued" });
      expect((await f.bridge.conversation("root")).costApprovals?.[0]).toMatchObject({ kind: "coordinatorInput", cacheHeat: "cold" });
    } finally { f.bridge.dispose(); }
  });
  it("restores a queued cost review without replay, and cancellation never sends it", async () => {
    const f = fixture(), evaluation = { required: true, signature: "cold-model-a", review: { capturedAt: 123, model: "model-a", cacheHeat: "cold", targetStatus: "idle", context: { used: 80000, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } };
    Object.assign(f.facade, { sessionCostReview: () => evaluation }); Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    await f.bridge.sendMessage(message); await f.bridge.drain(); const checkpoint = f.bridge.capture(); f.bridge.dispose();
    const cold = fixture(); Object.assign(cold.facade, { sessionCostReview: () => evaluation }); Object.assign(cold.deps, { confirmCostReview: vi.fn(async () => true) });
    cold.bridge.restore(checkpoint);
    try {
      const view = await cold.bridge.conversation("root"), approval = view.costApprovals![0];
      expect(cold.facade.continueMessage).not.toHaveBeenCalled();
      await cold.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId, decision: "cancel" });
      await cold.bridge.drain(); expect(cold.facade.continueMessage).not.toHaveBeenCalled();
      expect(await cold.bridge.messageReceipt("root", message.requestId)).toMatchObject({ status: "cancelled" });
    } finally { cold.bridge.dispose(); }
  });
  it("does not let send-now bypass a coordinator input cost review", async () => {
    const f = fixture(), prepare = vi.fn(async () => {});
    (f.facade as unknown as HostTaskFacade).prepareImmediateMessage = prepare;
    Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature: "cold", review: { capturedAt: 1, model: "model-a", cacheHeat: "cold", targetStatus: "idle", context: { used: 80000, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } }) });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      await expect(f.bridge.sendMessageNow("root", message.requestId, 1)).rejects.toThrow("cost review");
      expect(prepare).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
      expect(await f.bridge.messageReceipt("root", message.requestId)).toMatchObject({ status: "queued" });
    } finally { f.bridge.dispose(); }
  });
  it("permits cost review of a deliberate continuation after the stopped coordinator has settled", async () => {
    const f = fixture();
    Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature: "cold", review: { capturedAt: 1, model: "model-a", cacheHeat: "cold", targetStatus: "idle", context: { used: 80000, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } }) });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true) });
    try {
      expect((await f.bridge.stopConversation("root")).status).toBe("cancelled");
      await f.bridge.sendMessage(message); await f.bridge.drain();
      const view = await f.bridge.conversation("root"), approval = view.costApprovals![0];
      expect(approval).toMatchObject({ kind: "coordinatorInput" });
      await f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" });
      await f.bridge.drain(); expect(f.facade.continueMessage).toHaveBeenCalledOnce();
    } finally { f.bridge.dispose(); }
  });
  it("does not dispatch an input when exact coordinator cost identity is unavailable", async () => {
    const f = fixture(); Object.assign(f.facade, { sessionCostReview: () => null });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false, error: expect.any(String) });
      expect(await f.bridge.cancelMessage("root", message.requestId)).toMatchObject({ status: "cancelled" });
    } finally { f.bridge.dispose(); }
  });
  it("previews the full coordinator input and its image identities without accepting or cancelling it", async () => {
    const f = fixture(), text = "长消息🙂".repeat(400), fullPrompt = `引用资料\n${text}`;
    Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature: "cold", review: { capturedAt: 123, model: "model-a", cacheHeat: "cold", targetStatus: "idle", context: { used: 80000, capacityKnown: false, kind: "current_context", reference: false, modelMismatch: false } } }), inspect: () => "idle" });
    Object.assign(f.deps, { confirmCostReview: vi.fn(async () => true), handoffExcerpt: vi.fn(async () => ({ messages: [{ seq: 1, role: "assistant", text: "原会话摘要", truncated: false }], nextBefore: 0, truncated: true })) });
    try {
      await f.bridge.sendMessage({ ...message, prompt: fullPrompt, displayText: text, images: ["image-1"] }); await f.bridge.drain();
      const view = await f.bridge.conversation("root"), approval = view.costApprovals![0];
      expect(approval.truncated).toBe(true);
      const result = await f.bridge.previewCostHandoff!({ conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId });
      expect(result).toMatchObject({ kind: "coordinatorInput", source: f.ref, message: text, originalPrompt: fullPrompt, images: ["image-1"], excerpt: { truncated: true }, sourceStamp: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(await f.bridge.messageReceipt("root", message.requestId)).toMatchObject({ status: "queued" });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("does not expose a stale cross-session handoff after its full message changes during history loading", async () => {
    const gate = deferred<any>(), approval = { id: "cost-1", requestId: "held-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" }, target: { engine: "agy", sessionId: "target", workspacePath: "G:/project" }, message: "x".repeat(1200), truncated: true, model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    let full = approval.message + "old tail";
    const cost = { read: () => [approval], confirm: vi.fn(async () => true), resolve: vi.fn(async () => {}) }, f = fixture(new Map(), cost);
    Object.assign(f.facade, { captureCostApproval: () => ({ approval, message: full, kind: "cross-session" }), inspect: () => "idle" });
    Object.assign(f.deps, { handoffExcerpt: () => gate.promise });
    try {
      const view = await f.bridge.conversation("root");
      const pending = f.bridge.previewCostHandoff!({ conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId });
      await new Promise(resolve => setTimeout(resolve, 0)); full = approval.message + "different tail";
      gate.resolve({ messages: [], nextBefore: null, truncated: false });
      await expect(pending).rejects.toThrow("changed"); expect(cost.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve({ messages: [], nextBefore: null, truncated: false }); f.bridge.dispose(); }
  });
  it.each([
    ["case change", "G:/TARGET", false],
    ["trailing separator change", "G:/target/", false],
    ["Windows separator alias", "G:\\target", true],
  ])("revalidates the exact handoff target across history loading: %s", async (_label, nextPath, sameIdentity) => {
    const gate = deferred<any>();
    const approval = { id: "cost-1", requestId: "held-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" },
      target: { engine: "agy", sessionId: "target", workspacePath: "G:/target" }, message: "held message", truncated: false,
      model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    const cost = { read: () => [approval], confirm: vi.fn(async () => true), resolve: vi.fn(async () => {}) }, f = fixture(new Map(), cost);
    Object.assign(f.facade, { captureCostApproval: () => ({ approval, message: approval.message, kind: "cross-session" }), inspect: () => "idle" });
    Object.assign(f.deps, { handoffExcerpt: () => gate.promise });
    try {
      const view = await f.bridge.conversation("root");
      const pending = f.bridge.previewCostHandoff!({ conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId });
      await new Promise(resolve => setTimeout(resolve, 0)); approval.target.workspacePath = nextPath;
      gate.resolve({ messages: [], nextBefore: null, truncated: false });
      if (sameIdentity) expect((await pending).source.workspacePath).toBe("G:/target");
      else await expect(pending).rejects.toThrow("changed");
      expect(cost.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve({ messages: [], nextBefore: null, truncated: false }); f.bridge.dispose(); }
  });
  it.each([
    ["case change", "G:/TARGET", false],
    ["trailing separator change", "G:/target/", false],
    ["Windows separator alias", "G:\\target", true],
  ])("revalidates the exact cost target after human confirmation: %s", async (_label, nextPath, sameIdentity) => {
    const gate = deferred<boolean>();
    const approval = { id: "cost-1", requestId: "held-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" },
      target: { engine: "agy", sessionId: "target", workspacePath: "G:/target" }, message: "held message", truncated: false,
      model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    const cost = { read: () => [approval], confirm: vi.fn(() => gate.promise), resolve: vi.fn(async () => {}) }, f = fixture(new Map(), cost);
    try {
      const view = await f.bridge.conversation("root");
      const pending = f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" });
      await vi.waitFor(() => expect(cost.confirm).toHaveBeenCalledOnce());
      approval.target.workspacePath = nextPath; gate.resolve(true);
      if (sameIdentity) { await pending; expect(cost.resolve).toHaveBeenCalledOnce(); }
      else { await expect(pending).rejects.toThrow("changed"); expect(cost.resolve).not.toHaveBeenCalled(); }
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });
  it("does not reuse a handoff preview when the held request changes to another owned sender", async () => {
    const gate = deferred<any>();
    const approval = { id: "cost-1", requestId: "held-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" },
      target: { engine: "agy", sessionId: "target", workspacePath: "G:/project" }, message: "held message", truncated: false,
      model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    const cost = { read: () => [approval], confirm: vi.fn(async () => true), resolve: vi.fn(async () => {}) }, f = fixture(new Map(), cost);
    const child = { engine: "codex", sessionId: "owned-child", workspacePath: "G:/project" };
    f.branches.push({ id: "child", title: "Child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId, parentWorkspacePath: f.ref.workspacePath, ...child, state: "running" });
    Object.assign(f.facade, { captureCostApproval: () => ({ approval, message: approval.message, kind: "cross-session" }), inspect: () => "idle" });
    Object.assign(f.deps, { handoffExcerpt: () => gate.promise });
    try {
      const view = await f.bridge.conversation("root");
      const pending = f.bridge.previewCostHandoff!({ conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId });
      await new Promise(resolve => setTimeout(resolve, 0)); approval.sender = child;
      gate.resolve({ messages: [], nextBefore: null, truncated: false });
      await expect(pending).rejects.toThrow("changed"); expect(cost.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve({ messages: [], nextBefore: null, truncated: false }); f.bridge.dispose(); }
  });
  it("retains the exact input tier and waits for a new native turn when the active tier differs", async () => {
    const f = fixture();
    const owned = await f.deps.owned("root");
    f.deps.owned.mockResolvedValue({ ...owned, receipt: { ...owned.receipt, runId: "initial-run" }, launch: { codexServiceTierOverride: "default" } } as never);
    f.state.status = "busy"; f.state.runId = "initial-run"; f.state.canDeliver = true;
    try {
      const priority = { ...message, codexServiceTier: "priority" as const };
      await f.bridge.sendMessage(priority); await f.bridge.drain();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      await expect(f.bridge.sendMessage({ ...priority, codexServiceTier: "default" })).rejects.toThrow("fingerprint");
      expect(f.bridge.capture().records[0].inputs[0].codexServiceTier).toBe("priority");
      f.state.status = "idle"; f.state.runId = null;
      await f.bridge.drain();
      expect(f.facade.continueMessage).toHaveBeenCalledOnce();
      expect(f.facade.continueMessage.mock.calls[0][0]).toEqual(f.ref);
      expect((f.facade.continueMessage.mock.calls[0] as unknown[])[5]).toMatchObject({ codexServiceTierOverride: "priority" });
      expect(f.bridge.capture().records[0].serviceTierRun).toEqual({ runId: "follow-run", tier: "priority" });
      f.state.canDeliver = true;
      await f.bridge.sendMessage({ ...message, requestId: "follow-global", expectedInputRevision: 1 });
      await f.bridge.drain();
      expect(f.facade.continueMessage).toHaveBeenCalledOnce();
      f.proofs.set("follow-run", { status: "completed" }); f.state.status = "idle"; f.state.runId = null;
      await f.bridge.drain();
      expect((f.facade.continueMessage.mock.calls[1] as unknown[])[5]).toBeUndefined();
      expect(f.bridge.capture().records[0].serviceTierRun?.tier).toBe("inherit");
    } finally { f.bridge.dispose(); }
  });
  it("rejects unsupported or invalid tiers before accepting an input", async () => {
    const f = fixture();
    try {
      f.facade.codexServiceTierOverrideSupported.mockResolvedValue(false);
      await expect(f.bridge.sendMessage({ ...message, codexServiceTier: "priority" })).rejects.toThrow("unavailable");
      await expect(f.bridge.sendMessage({ ...message, codexServiceTier: "fast" } as never)).rejects.toThrow("Invalid continuation");
      expect(f.bridge.capture().records[0].inputs).toHaveLength(0);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("restores the queued tier without replay or letting send-now steer into a different tier", async () => {
    const first = fixture();
    const base = await first.deps.owned("root");
    const owner = { ...base, receipt: { ...base.receipt, runId: "initial-run" }, launch: { codexServiceTierOverride: "default" } };
    first.deps.owned.mockResolvedValue(owner as never);
    first.state.status = "busy"; first.state.runId = "initial-run"; first.state.canDeliver = true;
    const request = { ...message, codexServiceTier: "priority" as const };
    await first.bridge.sendMessage(request); await first.bridge.drain();
    const checkpoint = first.bridge.capture(); first.bridge.dispose();
    const cold = fixture(); cold.deps.owned.mockResolvedValue(owner as never);
    cold.state.status = "busy"; cold.state.runId = "initial-run"; cold.state.canDeliver = true;
    const prepare = vi.fn(async () => {}); (cold.facade as unknown as HostTaskFacade).prepareImmediateMessage = prepare;
    cold.bridge.restore(checkpoint);
    try {
      expect((await cold.bridge.sendMessage(request)).status).toBe("queued");
      await expect(cold.bridge.sendMessageNow("root", "input-one", 1)).rejects.toThrow("service tier");
      expect(prepare).not.toHaveBeenCalled(); expect(cold.facade.continueMessage).not.toHaveBeenCalled();
      cold.state.status = "idle"; cold.state.runId = null;
      await cold.bridge.drain();
      expect((cold.facade.continueMessage.mock.calls[0] as unknown[])[5]).toMatchObject({ codexServiceTierOverride: "priority" });
    } finally { cold.bridge.dispose(); }
  });
  it("projects only the idle owned coordinator prediction and dismisses its exact generation", async () => {
    let value: { id: number; text: string } | null = { id: 7, text: "继续讨论🙂" };
    const prediction = { read: () => value, dismiss: vi.fn((_ref, id) => { if (value?.id !== id) return false; value = null; return true; }) };
    const f = fixture(new Map(), undefined, prediction);
    try {
      const view = await f.bridge.conversation("root");
      expect(view.composerPrediction).toEqual(value);
      const action = { type: "dismissPrediction" as const, conversationRequestId: "root", expectedRevision: view.revision, predictionId: 7 };
      value = { id: 8, text: "继续讨论🙂" };
      await f.bridge.conversationAction("root", action);
      expect(prediction.dismiss).not.toHaveBeenCalled();
      const fresh = await f.bridge.conversation("root");
      await f.bridge.conversationAction("root", { ...action, predictionId: 8, expectedRevision: fresh.revision });
      expect(prediction.dismiss).toHaveBeenCalledExactlyOnceWith(f.ref, 8);
      expect((await f.bridge.conversation("root")).composerPrediction).toBeNull();
      value = { id: 9, text: "新建议" }; f.state.status = "busy";
      expect((await f.bridge.conversation("root")).composerPrediction).toBeNull();
      f.state.status = "idle"; f.state.canDeliver = false;
      expect((await f.bridge.conversation("root")).composerPrediction).toBeNull();
    } finally { f.bridge.dispose(); }
  });
  it("waits for a human cost decision without blocking inspection or allowing a duplicate", async () => {
    const gate = deferred<boolean>(), approval = { id: "cost-1", requestId: "request-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" }, target: { engine: "agy", sessionId: "target", workspacePath: "G:/project" }, message: "ask", truncated: false, model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    const cost = { read: () => [approval], confirm: vi.fn(() => gate.promise), resolve: vi.fn(async () => {}) };
    const f = fixture(new Map(), cost);
    try {
      const view = await f.bridge.conversation("root");
      const action = { type: "requestCostReview" as const, conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" as const };
      const pending = f.bridge.conversationAction("root", action);
      await vi.waitFor(() => expect(cost.confirm).toHaveBeenCalledOnce());
      expect((await f.bridge.conversation("root")).costApprovals).toHaveLength(1);
      await expect(f.bridge.conversationAction("root", action)).rejects.toThrow("already open");
      gate.resolve(false); await pending;
      expect(cost.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });

  it("rejects a changed approval after confirmation and applies only the current identity", async () => {
    const gate = deferred<boolean>(), approval = { id: "cost-1", requestId: "request-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" }, target: { engine: "agy", sessionId: "target", workspacePath: "G:/project" }, message: "ask", truncated: false, model: "gemini", cacheHeat: "unknown", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    const cost = { read: () => [approval], confirm: vi.fn(() => gate.promise), resolve: vi.fn(async () => {}) };
    const f = fixture(new Map(), cost);
    try {
      const view = await f.bridge.conversation("root");
      const action = { type: "requestCostReview" as const, conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId, decision: "handoff" as const };
      const pending = f.bridge.conversationAction("root", action);
      await vi.waitFor(() => expect(cost.confirm).toHaveBeenCalledOnce());
      approval.model = "another-model"; gate.resolve(true);
      await expect(pending).rejects.toThrow("changed"); expect(cost.resolve).not.toHaveBeenCalled();
      const fresh = await f.bridge.conversation("root");
      await f.bridge.conversationAction("root", { ...action, expectedRevision: fresh.revision });
      expect(cost.resolve).toHaveBeenCalledOnce();
      expect(cost.resolve).toHaveBeenCalledWith([f.ref], expect.objectContaining({ id: approval.id, model: "another-model" }), "handoff");
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });
  it("revalidates the full held cross-session message beyond its truncated card", async () => {
    const gate = deferred<boolean>(), approval = { id: "cost-1", requestId: "request-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" }, target: { engine: "agy", sessionId: "target", workspacePath: "G:/project" }, message: "x".repeat(1200), truncated: true, model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    let fullMessage = approval.message + "original tail";
    const cost = { read: () => [approval], confirm: vi.fn(() => gate.promise), resolve: vi.fn(async () => {}) };
    const f = fixture(new Map(), cost);
    Object.assign(f.facade, { captureCostApproval: () => ({ approval, message: fullMessage, kind: "cross-session" }) });
    try {
      const view = await f.bridge.conversation("root");
      const pending = f.bridge.conversationAction("root", { type: "requestCostReview", conversationRequestId: "root", expectedRevision: view.revision,
        approvalId: approval.id, approvalRequestId: approval.requestId, decision: "approve" });
      await vi.waitFor(() => expect(cost.confirm).toHaveBeenCalledOnce());
      fullMessage = approval.message + "different tail"; gate.resolve(true);
      await expect(pending).rejects.toThrow("changed"); expect(cost.resolve).not.toHaveBeenCalled();
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });

  it("freezes the requested decision before showing the human confirmation", async () => {
    const gate = deferred<boolean>(), approval = { id: "cost-1", requestId: "request-1", sender: { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" }, target: { engine: "agy", sessionId: "target", workspacePath: "G:/project" }, message: "ask", truncated: false, model: "gemini", cacheHeat: "cold", usageKind: "unknown", capturedAt: 10, canHandoff: true };
    const cost = { read: () => [approval], confirm: vi.fn(() => gate.promise), resolve: vi.fn(async () => {}) };
    const f = fixture(new Map(), cost);
    try {
      const view = await f.bridge.conversation("root");
      const action = { type: "requestCostReview" as const, conversationRequestId: "root", expectedRevision: view.revision, approvalId: approval.id, approvalRequestId: approval.requestId, decision: "handoff" as "handoff" | "approve" };
      const pending = f.bridge.conversationAction("root", action);
      await vi.waitFor(() => expect(cost.confirm).toHaveBeenCalledOnce());
      action.decision = "approve"; gate.resolve(true); await pending;
      expect(cost.confirm).toHaveBeenCalledWith(expect.anything(), "handoff");
      expect(cost.resolve).toHaveBeenCalledWith([f.ref], expect.anything(), "handoff");
    } finally { gate.resolve(false); f.bridge.dispose(); }
  });
  function coldFixture() {
    const f = fixture();
    f.bridge.restore({ version: 1, records: [{ requestId: "root", revision: 1, inputRevision: 0, sessionRef: f.ref,
      stopping: true, stopRunId: "archived-run", stopEpoch: 1, inputs: [] }] });
    return f;
  }

  it("keeps inspection nonblocking, deduplicates slow recovery, and discards a previous stop epoch", async () => {
    const f = coldFixture(), gate = deferred<{ status: "completed" }>();
    f.facade.recoverSettledRun.mockReturnValueOnce(gate.promise);
    try {
      expect((await f.bridge.conversation("root")).status).toBe("stopping");
      expect((await f.bridge.conversation("root")).status).toBe("stopping");
      expect(f.facade.recoverSettledRun).toHaveBeenCalledTimes(1);
      // A repeated stop remains actionable and preserves the recovered stop ID
      // even though the cold timeline has no nativeTaskRunId.
      expect((await f.bridge.stopConversation("root")).status).toBe("stopping");
      expect(f.bridge.capture().records[0]).toMatchObject({ stopEpoch: 2, stopRunId: "archived-run" });
      gate.resolve({ status: "completed" }); await f.bridge.drain();
      expect(f.bridge.capture().records[0].stopTerminalProof).toBeUndefined();
      expect((await f.bridge.conversation("root")).status).toBe("stopping");
    } finally { f.bridge.dispose(); }
  });

  it("cools down missing evidence but retries after a native terminal event", async () => {
    const f = coldFixture();
    try {
      await f.bridge.conversation("root"); await f.bridge.drain(); await f.bridge.conversation("root");
      expect(f.facade.recoverSettledRun).toHaveBeenCalledTimes(1);
      f.facade.recoverSettledRun.mockResolvedValue({ status: "completed" });
      f.events([{ runId: "archived-run", engine: f.ref.engine, sessionId: f.ref.sessionId, seq: 9, kind: "done", data: {} }]);
      await vi.waitFor(async () => expect((await f.bridge.conversation("root")).status).toBe("cancelled"));
      expect(f.facade.recoverSettledRun).toHaveBeenCalledTimes(2);
      expect(f.facade.continueMessage).not.toHaveBeenCalled(); expect(f.facade.interrupt).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });

  it("keeps a storage failure fenced instead of publishing verified cancellation", async () => {
    const f = coldFixture(), seen: string[] = [];
    f.facade.recoverSettledRun.mockResolvedValue({ status: "completed" });
    const write = f.deps.storage.set;
    f.deps.storage.set = async (p, k, value) => {
      if ((value as any).records?.[0]?.stopTerminalProof) throw new Error("disk unavailable");
      await write(p, k, value);
    };
    f.bridge.onConversationEvent(view => seen.push(view.status));
    try {
      await f.bridge.conversation("root");
      await vi.waitFor(() => expect(f.deps.hold).toHaveBeenCalledWith("root", true));
      await expect(f.bridge.drain()).rejects.toThrow("persistence");
      expect(seen).not.toContain("cancelled");
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });

  it("does not use a delayed proof after coordinator ownership changes", async () => {
    const f = coldFixture(), gate = deferred<{ status: "completed" }>();
    f.facade.recoverSettledRun.mockReturnValue(gate.promise);
    try {
      await f.bridge.conversation("root");
      const owned = await f.deps.owned("root");
      f.deps.owned.mockResolvedValue({ ...owned, proven: false });
      gate.resolve({ status: "completed" });
      await vi.waitFor(() => expect(f.bridge.capture().records[0].ownershipError).toBeTruthy());
      expect(f.bridge.capture().records[0].stopTerminalProof).toBeUndefined();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });

  it("rechecks children appearing while recovery is pending", async () => {
    const f = coldFixture(), gate = deferred<{ status: "completed" }>();
    f.facade.recoverSettledRun.mockReturnValue(gate.promise);
    try {
      await f.bridge.conversation("root");
      f.branches.push({ id: "late", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId, engine: "codex", sessionId: "child", workspacePath: f.ref.workspacePath, state: "running" });
      gate.resolve({ status: "completed" });
      await vi.waitFor(() => expect(f.bridge.capture().records[0].stopTerminalProof).toBeDefined());
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "stopping", canSend: false, children: [{ id: "late", state: "running" }] });
    } finally { f.bridge.dispose(); }
  });

  it.each(["queued", "unknown"])("retains %s delivery fences with recovered stop evidence", async status => {
    const original = fixture(); original.state.canDeliver = false;
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    cut.records[0].stopping = true; cut.records[0].stopRunId = "archived-run";
    cut.records[0].inputs[0].receipt.status = status as "queued" | "unknown";
    const f = fixture(); f.bridge.restore(cut); f.facade.recoverSettledRun.mockResolvedValue({ status: "completed" });
    try {
      await f.bridge.conversation("root");
      await vi.waitFor(() => expect(f.bridge.capture().records[0].stopTerminalProof).toBeDefined());
      expect((await f.bridge.conversation("root")).status).toBe(status === "queued" ? "stopping" : "unknown");
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("publishes durable stopping before a delayed parent interrupt and waits for real settlement", async () => {
    const f = fixture(); await f.bridge.ready(); await f.bridge.drain();
    f.state.status = "busy"; f.state.runId = "parent-run";
    const gate = deferred<boolean>(), seen: any[] = [];
    f.bridge.onConversationEvent(view => seen.push(view));
    await f.bridge.drain();
    f.facade.interrupt.mockImplementationOnce(async () => {
      expect(seen.at(-1)).toMatchObject({ status: "stopping", stopRequested: true, canSend: false });
      expect((f.saved.get("__host_tasks_v1:conversations") as any).records[0]).toMatchObject({ stopping: true, stopRunId: "parent-run" });
      return gate.promise;
    });
    let finished = false;
    const stopping = f.bridge.stopConversation("root").then(view => { finished = true; return view; });
    await vi.waitFor(() => expect(f.facade.interrupt).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false); expect(seen.some(view => view.status === "cancelled")).toBe(false);
    gate.resolve(true);
    expect(await stopping).toMatchObject({ status: "stopping", stopRequested: true });
    f.state.status = "idle"; f.state.runId = null; f.proofs.set("parent-run", { status: "cancelled" });
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "cancelled", stopRequested: true });
    f.bridge.dispose();
  });
  it("publishes stopping before delayed child retirement without reordering or inventing completion", async () => {
    const f = fixture(); await f.bridge.ready(); await f.bridge.drain();
    f.branches.push({ id: "child", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "child-session", workspacePath: "G:/project", state: "running" });
    const gate = deferred<void>(), seen: any[] = [];
    f.bridge.onConversationEvent(view => seen.push(view));
    await f.bridge.drain();
    f.facade.stopChild.mockImplementationOnce(async () => {
      expect(seen.at(-1)).toMatchObject({ status: "stopping", stopRequested: true, children: [{ id: "child", state: "running" }] });
      return gate.promise;
    });
    let finished = false;
    const stopping = f.bridge.stopConversation("root").then(view => { finished = true; return view; });
    await vi.waitFor(() => expect(f.facade.stopChild).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false); expect(f.facade.interrupt).not.toHaveBeenCalled();
    gate.resolve();
    expect(await stopping).toMatchObject({ status: "stopping", stopRequested: true });
    f.branches[0].state = "stopped";
    expect((await f.bridge.conversation("root")).status).toBe("cancelled");
    f.bridge.dispose();
  });
  it("publishes stop failures to subscribers without claiming active parent or child cancellation", async () => {
    const f = fixture(); await f.bridge.ready(); await f.bridge.drain();
    f.state.status = "busy"; f.state.runId = "parent-run";
    f.branches.push({ id: "child", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "child-session", workspacePath: "G:/project", state: "running" });
    const seen: any[] = []; f.bridge.onConversationEvent(view => seen.push(view));
    await f.bridge.drain();
    f.facade.interrupt.mockRejectedValueOnce(new Error("interrupt unavailable"));
    f.facade.stopChild.mockRejectedValueOnce(new Error("retirement unavailable"));
    const view = await f.bridge.stopConversation("root");
    expect(view).toMatchObject({ status: "stopping", stopRequested: true, canSend: false });
    expect(view.error).toContain("Coordinator stop failed");
    expect(view.error).toContain("Child stop could not be confirmed: child");
    expect(seen.at(-1)).toEqual(view);
    expect(seen.some(value => value.status === "cancelled")).toBe(false);
    expect((await f.bridge.conversation("root")).error).toBe(view.error);
    f.state.status = "idle"; f.state.runId = null; f.proofs.set("parent-run", { status: "cancelled" }); f.branches[0].state = "stopped";
    const settled = await f.bridge.conversation("root");
    expect(settled.status).toBe("cancelled"); expect(settled.error).toBeUndefined();
    f.bridge.dispose();
  });
  it.each(["claude", "codex", "agy"])("%s queues changed instructions during a live turn and persists them only before the next full launch", async engine => {
    const f = fixture(undefined, undefined, undefined, engine); const v1 = { version: "v1", text: "First policy" }, v2 = { version: "v2", text: "Second policy" };
    const owned = await f.deps.owned("root"); f.deps.owned.mockResolvedValue({ ...owned, fixedInstructions: v1 } as never);
    f.state.status = "busy"; f.state.runId = "initial-run"; f.state.canDeliver = true;
    await f.bridge.sendMessage({ ...message, fixedInstructions: v2 }); await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.capture().records[0].fixedInstructions).toBeUndefined();
    await expect(f.bridge.sendMessage({ ...message, fixedInstructions: v1 })).rejects.toThrow("fingerprint");
    f.state.status = "idle"; f.state.runId = null;
    const original = f.facade.continueMessage.getMockImplementation()!;
    f.facade.continueMessage.mockImplementationOnce(async (...args) => {
      const fence = args[4]; args[4] = async (delivery: string, run: string) => {
        await fence(delivery, run);
        expect((f.saved.get("__host_tasks_v1:conversations") as any).records[0].fixedInstructions).toEqual(v2);
      };
      return original(...args);
    });
    await f.bridge.drain(); expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    f.proofs.set("follow-run", { status: "completed" }); await f.bridge.messageReceipt("root", "input-one"); f.bridge.dispose();
    const cold = fixture(f.saved, undefined, undefined, engine); await cold.bridge.ready();
    expect(cold.bridge.capture().records[0].fixedInstructions).toEqual(v2);
    expect(cold.facade.continueMessage).not.toHaveBeenCalled(); cold.bridge.dispose();
  });
  it.each(["claude", "codex", "agy"])("%s keeps matching guidance on live input and does not apply a cancelled queued update", async engine => {
    const f = fixture(undefined, undefined, undefined, engine); const policy = { version: "v1", text: "Policy" };
    const owned = await f.deps.owned("root"); f.deps.owned.mockResolvedValue({ ...owned, fixedInstructions: policy } as never);
    f.state.status = "busy"; f.state.runId = "active";
    f.facade.continueMessage.mockImplementationOnce(async (_r, text, _i, _run, fence) => {
      expect(text).toBe("continue"); await fence("steer", "active"); return { delivery: "steer", runId: "active" };
    });
    await f.bridge.sendMessage({ ...message, fixedInstructions: policy }); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.delivery).toBe("steer");
    await f.bridge.sendMessage({ ...message, requestId: "change", expectedInputRevision: 1, fixedInstructions: { version: "v2", text: "Changed" } });
    await f.bridge.drain(); await f.bridge.cancelMessage("root", "change");
    expect(f.bridge.capture().records[0].fixedInstructions).toBeUndefined();
    expect(f.facade.continueMessage).toHaveBeenCalledTimes(1); f.bridge.dispose();
  });
  it("displayText previews and annotates only the exactly committed user row, without rewriting native text", async () => {
    const f = fixture(); const prompt = "{ injected: coordinator protocol }";
    const unrelated = { seq: 8, role: "user", text: prompt, ts: "2026-10-24T00:00:00Z" };
    const sent = { seq: 9, role: "user", text: prompt, ts: "2026-10-24T00:00:01Z" };
    (f.facade.continueMessage as any).mockImplementationOnce(async (_ref: unknown, _p: string, _i: string[], run: string, fence: any, _launch: unknown, onRow: any) => {
      await fence("turn", run); f.state.messages = [unrelated, sent];
      await onRow?.({ ...sent, runId: run }); return { delivery: "turn", runId: run };
    });
    const request = { ...message, prompt, displayText: "用户真实需求😀" };
    expect(await f.bridge.sendMessage(request)).toMatchObject({ preview: "用户真实需求😀" });
    await f.bridge.drain();
    const projected = (await f.bridge.conversation("root")).messages as any[];
    expect(projected[0]).not.toHaveProperty("displayText");
    expect(projected[1]).toMatchObject({ text: prompt, displayText: "用户真实需求😀" });
    expect(sent).not.toHaveProperty("displayText"); expect(sent.text).toBe(prompt);
    await expect(f.bridge.sendMessage({ ...request, displayText: "different goal" })).rejects.toThrow("fingerprint");
    const cut = f.bridge.capture(); f.bridge.dispose();
    const next = fixture(); next.state.messages = [unrelated, sent]; next.bridge.restore(cut);
    expect((await next.bridge.conversation("root")).messages[1]).toMatchObject({ displayText: "用户真实需求😀" });
    next.bridge.dispose();
  });
  it("keeps original AGY input receipts after native history renumbers rows without guessing display bindings", async () => {
    const f = fixture(); f.ref.engine = "agy";
    const prompt = "{ injected protocol }\n用户真实需求😀";
    const sent = { seq: 4, role: "user", text: prompt, ts: "2026-10-30T08:26:27.837Z" };
    (f.facade.continueMessage as any).mockImplementationOnce(async (_ref: unknown, _p: string, _i: string[], run: string, fence: any, _launch: unknown, onRow: any) => {
      await fence("turn", run); f.state.messages = [sent]; await onRow?.({ ...sent, runId: run });
      return { delivery: "turn", runId: run };
    });
    try {
      await f.bridge.sendMessage({ ...message, prompt, displayText: "用户真实需求😀" }); await f.bridge.drain();
      expect((await f.bridge.conversation("root")).messages[0]).toMatchObject({ displayText: "用户真实需求😀" });
      const receipt = await f.bridge.messageReceipt("root", "input-one");
      f.state.messages = [{ ...sent, seq: 3, ts: "2026-10-30T08:26:27.840Z" }];
      const restored = await f.bridge.conversation("root");
      expect(restored.messages[0]).toMatchObject({ text: prompt });
      expect(restored.messages[0]).not.toHaveProperty("displayText");
      expect(await f.bridge.messageReceipt("root", "input-one")).toEqual(receipt);
      expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    } finally { f.bridge.dispose(); }
  });
  it("P1 keeps stop intent after an empty snapshot and stops a late owned child on poll", async () => {
    const f = fixture();
    expect((await f.bridge.stopConversation("root")).status).toBe("cancelled");
    f.branches.push(
      { id: "late", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "late-session", workspacePath: "G:/project", state: "running" },
      { id: "other", parentEngine: "codex", parentSessionId: "unrelated", engine: "codex", sessionId: "other-session", workspacePath: "G:/project", state: "running" },
    );
    const waiting = await f.bridge.conversation("root");
    expect(f.facade.stopChild).toHaveBeenCalledExactlyOnceWith(f.ref, "late");
    expect(waiting).toMatchObject({ status: "stopping", canSend: false, canChangeSelection: false });
    await f.bridge.conversation("root"); expect(f.facade.stopChild).toHaveBeenCalledTimes(1);
    await expect(f.bridge.sendMessage(message)).rejects.toThrow(/cannot accept/);
    f.bridge.dispose();
  });
  it("P1 restores sticky stop intent and stops a child first discovered after cold recovery", async () => {
    const f = fixture(); await f.bridge.stopConversation("root"); f.bridge.dispose();
    const next = fixture(f.saved);
    next.branches.push({ id: "late-restored", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "late-session", workspacePath: "G:/project", state: "running" });
    await next.bridge.conversation("root");
    expect(next.facade.stopChild).toHaveBeenCalledExactlyOnceWith(next.ref, "late-restored");
    expect((await next.bridge.conversation("root")).canSend).toBe(false); next.bridge.dispose();
  });
  it("P1 never releases an observed active child when a later snapshot omits it", async () => {
    const f = fixture(); await f.bridge.stopConversation("root");
    f.branches.push({ id: "late", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "late-session", workspacePath: "G:/project", state: "running" });
    await f.bridge.conversation("root"); f.branches.length = 0;
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false, canChangeSelection: false, children: [{ id: "late", state: "unknown" }] });
    await expect(f.bridge.sendMessage(message)).rejects.toThrow("cannot accept");
    f.bridge.dispose(); const next = fixture(f.saved);
    expect((await next.bridge.conversation("root")).status).toBe("unknown"); next.bridge.dispose();
  });
  it("accepts once with exact fingerprint and input CAS without creating another business task", async () => {
    const f = fixture();
    const first = await f.bridge.sendMessage(message);
    expect(first.inputRevision).toBe(1);
    expect((await f.bridge.sendMessage(message)).requestId).toBe(first.requestId);
    await expect(f.bridge.sendMessage({ ...message, prompt: "changed" })).rejects.toThrow(/fingerprint/i);
    await expect(f.bridge.sendMessage({ ...message, requestId: "input-two" })).rejects.toThrow(/revision/i);
    await f.bridge.drain();
    expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    f.bridge.dispose();
  });
  it("keeps unsupported busy input queued and cancels without native send", async () => {
    const f = fixture(); f.state.status = "busy"; f.state.canDeliver = false;
    expect((await f.bridge.sendMessage(message)).status).toBe("queued");
    await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect((await f.bridge.cancelMessage("root", "input-one"))?.status).toBe("cancelled");
    f.bridge.dispose();
  });
  it("does not replay fenced work after a lost ACK and restart", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("unknown");
    f.bridge.dispose();
    const restored = fixture(f.saved);
    expect((await restored.bridge.sendMessage(message)).status).toBe("unknown");
    await restored.bridge.drain(); expect(restored.facade.continueMessage).not.toHaveBeenCalled();
    expect((await restored.bridge.conversation("root")).canChangeSelection).toBe(false);
    restored.bridge.dispose();
  });
  it("rejects arbitrary native session ids", async () => {
    const f = fixture(); await expect(f.bridge.conversation("native-one")).rejects.toThrow("Unknown owned task"); f.bridge.dispose();
  });
  it("holds native descendants after the initial parent turn finished and stops only the real ownership tree", async () => {
    const f = fixture();
    f.branches.push(
      { id: "child", title: "Child", parentEngine: "codex", parentSessionId: "native-one", parentWorkspacePath: "G:/project", engine: "codex", sessionId: "child-session", workspacePath: "G:/member", state: "completed" },
      { id: "grandchild", title: "Grandchild", parentEngine: "codex", parentSessionId: "child-session", parentWorkspacePath: "G:/member", engine: "codex", sessionId: "grandchild-session", workspacePath: "G:/member", state: "running" },
      { id: "unrelated", title: "Other", parentEngine: "codex", parentSessionId: "native-one", parentWorkspacePath: "G:/other", engine: "codex", sessionId: "other-session", workspacePath: "G:/other", state: "running" },
    );
    const snapshot = await f.bridge.conversation("root");
    expect(snapshot.children.map(c => c.id)).toEqual(["child", "grandchild"]);
    expect(snapshot.canChangeSelection).toBe(false); expect(snapshot.status).toBe("running");
    const stopping = await f.bridge.stopConversation("root");
    expect(f.facade.stopChild).toHaveBeenCalledExactlyOnceWith({ engine: "codex", sessionId: "child-session", workspacePath: "G:/member" }, "grandchild");
    expect(stopping.status).toBe("stopping");
    f.branches[1].state = "stopped";
    expect((await f.bridge.conversation("root")).status).toBe("cancelled");
    f.bridge.dispose();
  });
  it("uses a native turn_complete for a received live input, with identity and sequence checks", async () => {
    const f = fixture();
    await f.bridge.ready();
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 8, data: {}, ts: 100 }]);
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "other", kind: "turn_complete", seq: 9, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 8, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 10, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("completed");
    f.bridge.dispose();
  });
  it("never treats a finished run as proof that an unknown input arrived", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.proofs.set("follow-run", { status: "completed" });
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 10, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("unknown");
    expect(await f.bridge.stopConversation("root")).toMatchObject({ status: "cancelled", canSend: true });
    expect(await f.bridge.messageReceipt("root", "input-one")).toMatchObject({ status: "unknown", stopResolved: true });
    f.bridge.dispose();
  });
  it("releases a finished dedicated turn without claiming that its unknown input arrived or replaying it", async () => {
    const original = fixture();
    original.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(), proof = deferred<{ status: "completed" } | null>();
    f.facade.recoverSettledRun.mockReturnValue(proof.promise); f.bridge.restore(cut);
    try {
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      proof.resolve({ status: "completed" });
      await vi.waitFor(async () => expect(await f.bridge.messageReceipt("root", "input-one"))
        .toMatchObject({ status: "unknown", terminalOutcome: "completed", runId: "follow-run" }));
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "idle", canSend: true });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      expect(await f.bridge.sendMessage(message)).toMatchObject({ status: "unknown", terminalOutcome: "completed" });
      const restarted = fixture(); restarted.bridge.restore(f.bridge.capture());
      try { expect(await restarted.bridge.messageReceipt("root", "input-one")).toMatchObject({ status: "unknown", terminalOutcome: "completed" }); }
      finally { restarted.bridge.dispose(); }
    } finally { proof.resolve(null); f.bridge.dispose(); }
  });
  it.each(["steer", "live"] as const)("does not release an unknown %s input from its shared run outcome", async delivery => {
    const original = fixture();
    original.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose(); cut.records[0].inputs[0].receipt.delivery = delivery;
    const f = fixture(); f.facade.recoverSettledRun.mockResolvedValue({ status: "completed" }); f.bridge.restore(cut);
    try {
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect(f.facade.recoverSettledRun).not.toHaveBeenCalled();
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("defers a late terminal proof while the host is paused and retries after resuming", async () => {
    const original = fixture();
    original.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(), proof = deferred<{ status: "completed" } | null>();
    let paused = false;
    Object.assign(f.deps, { paused: () => paused });
    f.facade.recoverSettledRun.mockReturnValueOnce(proof.promise).mockResolvedValue({ status: "completed" });
    f.bridge.restore(cut);
    try {
      await f.bridge.conversation("root");
      expect(f.facade.recoverSettledRun).toHaveBeenCalledTimes(1);
      paused = true; proof.resolve({ status: "completed" });
      await Promise.resolve(); await Promise.resolve(); await f.bridge.drain();
      expect(f.bridge.capture().records[0].inputs[0].receipt.terminalOutcome).toBeUndefined();
      paused = false;
      await f.bridge.conversation("root");
      await vi.waitFor(async () => expect(await f.bridge.messageReceipt("root", "input-one"))
        .toMatchObject({ status: "unknown", terminalOutcome: "completed" }));
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { proof.resolve(null); f.bridge.dispose(); }
  });
  it("continues recovery for other coordinators while earlier archive queries cool down", async () => {
    const original = fixture();
    original.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const template = original.bridge.capture().records[0]; original.bridge.dispose();
    const f = fixture(), refs = new Map<string, typeof f.ref>();
    const records = Array.from({ length: 5 }, (_, index) => {
      const record = structuredClone(template), id = `root-${index}`, inputId = `input-${index}`;
      const ref = { ...f.ref, sessionId: `session-${index}` }; refs.set(id, ref);
      record.requestId = id; record.sessionRef = ref;
      const input = record.inputs[0]; input.receipt.conversationRequestId = id; input.receipt.requestId = inputId;
      input.receipt.runId = `run-${index}`; input.receipt.sessionRef = ref;
      input.fingerprint = JSON.stringify([id, inputId, 0, input.prompt, input.images]);
      delete record.serviceTierRun;
      return record;
    });
    f.deps.owned.mockImplementation(async id => ({ receipt: { requestId: id, workspacePath: f.ref.workspacePath,
      session: refs.get(id)!, status: "completed" }, proven: true }));
    const pending = Array.from({ length: 4 }, () => deferred<{ status: "completed" } | null>());
    f.facade.recoverSettledRun.mockImplementation(runId => runId === "run-4"
      ? Promise.resolve({ status: "completed" }) : pending[Number(runId.slice(4))].promise);
    f.bridge.restore({ version: 1, records });
    try {
      await f.bridge.ready();
      for (let index = 0; index < 5; index++) await f.bridge.conversation(`root-${index}`);
      expect(f.facade.recoverSettledRun).toHaveBeenCalledTimes(4);
      pending[0].resolve(null);
      await vi.waitFor(() => expect(f.facade.recoverSettledRun).toHaveBeenCalledWith("run-4", refs.get("root-4"), { inputOnly: true }));
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { for (const item of pending) item.resolve(null); f.bridge.dispose(); }
  });
  it("keeps the original input fenced if its recovered terminal proof cannot be persisted", async () => {
    const original = fixture();
    original.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(), write = f.deps.storage.set;
    let attempted = false;
    f.facade.recoverSettledRun.mockResolvedValue({ status: "completed" });
    f.deps.storage.set = async (owner, key, value) => {
      if ((value as any).records?.[0]?.inputs?.[0]?.receipt?.terminalOutcome) { attempted = true; throw new Error("disk unavailable"); }
      await write(owner, key, value);
    };
    f.bridge.restore(cut);
    try {
      await f.bridge.conversation("root");
      await vi.waitFor(() => expect(attempted).toBe(true));
      expect(f.bridge.capture().records[0].inputs[0].receipt.terminalOutcome).toBeUndefined();
      expect((await f.bridge.conversation("root")).canSend).toBe(false);
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("releases a recovered unknown input only after an explicit stop and exact native settlement, without replay", async () => {
    const original = fixture();
    await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(); f.bridge.restore(cut);
    try {
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect(await f.bridge.stopConversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect(f.facade.recoverSettledRun).toHaveBeenCalledWith("follow-run", f.ref, { inputOnly: true });
      f.proofs.set("unrelated-run", { status: "cancelled" });
      expect((await f.bridge.conversation("root")).canSend).toBe(false);
      f.proofs.set("follow-run", { status: "cancelled" });
      const stopped = await f.bridge.conversation("root");
      expect(stopped).toMatchObject({ status: "cancelled", canSend: true, canChangeSelection: true, stopRequested: true });
      expect(stopped.deliveries[0]).toMatchObject({ requestId: message.requestId, status: "unknown", stopResolved: true,
        error: "Delivery outcome could not be confirmed after recovery; not replayed" });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      expect(await f.bridge.sendMessage(message)).toMatchObject({ status: "unknown", stopResolved: true });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
      f.deps.runId = () => "new-explicit-run";
      await f.bridge.sendMessage({ ...message, requestId: "input-two", expectedInputRevision: 1, prompt: "new explicit input" });
      await f.bridge.drain();
      expect(f.facade.continueMessage).toHaveBeenCalledExactlyOnceWith(f.ref, "new explicit input", [], "new-explicit-run", expect.any(Function), undefined);
      expect(await f.bridge.messageReceipt("root", message.requestId)).toMatchObject({ status: "unknown", stopResolved: true });
    } finally { f.bridge.dispose(); }
  });
  describe("legacy explicit stop boundary migration", () => {
    async function legacyCut(count = 8) {
      const original = fixture();
      for (let index = 0; index < count; index++) {
        original.deps.runId = () => `legacy-run-${index + 1}`;
        await original.bridge.sendMessage({ ...message, requestId: `legacy-input-${index + 1}`, expectedInputRevision: index });
        await original.bridge.drain();
        original.proofs.set(`legacy-run-${index + 1}`, { status: "completed" });
        Object.assign(original.state, { runId: null, status: "idle", canDeliver: true });
        await original.bridge.conversation("root");
      }
      const cut = original.bridge.capture(); original.bridge.dispose();
      const record = cut.records[0];
      record.stopping = true; record.stopEpoch = 1; record.children = [];
      delete record.stopInputRevision; delete record.stopRunId; delete record.stopTerminalProof;
      record.inputs.forEach((input, index) => {
        delete input.resumeStopEpoch;
        input.receipt.status = index >= 7 ? "unknown" : "completed";
      });
      return cut;
    }
    it.each(["stopping", "stopped"] as const)("recovers a legacy %s ledger with eight inputs through the exact native run without replay", async flag => {
      const cut = await legacyCut();
      if (flag === "stopped") { cut.records[0].stopping = false; cut.records[0].stopped = true; }
      const f = fixture(), gate = deferred<{ status: "completed" }>();
      f.facade.recoverSettledRun.mockReturnValue(gate.promise); f.bridge.restore(cut);
      try {
        expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
        expect(f.bridge.capture().records[0].stopInputRevision).toBe(8);
        expect(f.facade.recoverSettledRun).toHaveBeenCalledExactlyOnceWith("legacy-run-8", f.ref, { inputOnly: true });
        gate.resolve({ status: "completed" }); await f.bridge.drain();
        const view = await f.bridge.conversation("root");
        expect(view).toMatchObject({ status: "cancelled", canSend: true, children: [] });
        expect(view.deliveries.slice(0, 7).map(input => input.status)).toEqual(Array(7).fill("completed"));
        expect(view.deliveries[7]).toMatchObject({ requestId: "legacy-input-8", runId: "legacy-run-8", status: "unknown", stopResolved: true });
        expect(f.bridge.capture().records[0].inputs.map(input => ({ ...input.receipt, stopResolved: undefined })))
          .toEqual(cut.records[0].inputs.map(input => ({ ...input.receipt, stopResolved: undefined })));
        expect(f.facade.continueMessage).not.toHaveBeenCalled();
      } finally { gate.resolve({ status: "completed" }); f.bridge.dispose(); }
    });
    it.each(["no-stop", "zero-epoch", "missing-epoch", "wrong-run", "missing-native-proof"])("keeps a legacy unknown input fenced with %s", async kind => {
      const cut = await legacyCut(), record = cut.records[0];
      if (kind === "no-stop") record.stopping = false;
      if (kind === "zero-epoch") record.stopEpoch = 0;
      if (kind === "missing-epoch") delete record.stopEpoch;
      const f = fixture(); f.bridge.restore(cut);
      if (kind === "wrong-run") f.proofs.set("unrelated-run", { status: "completed" });
      else if (kind !== "missing-native-proof") f.proofs.set("legacy-run-8", { status: "completed" });
      try {
        await f.bridge.conversation("root"); await f.bridge.drain();
        expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
        expect((await f.bridge.messageReceipt("root", "legacy-input-8"))?.stopResolved).not.toBe(true);
        if (["no-stop", "zero-epoch", "missing-epoch"].includes(kind)) expect(f.bridge.capture().records[0].stopInputRevision).toBeUndefined();
        expect(f.facade.continueMessage).not.toHaveBeenCalled();
      } finally { f.bridge.dispose(); }
    });
    it.each([1, 2])("excludes resume epoch %i and later inputs from a legacy stop until a new explicit stop", async resumeEpoch => {
      const cut = await legacyCut(9), record = cut.records[0];
      record.inputs[6].receipt.status = "unknown";
      record.inputs[6].resumeStopEpoch = 0;
      record.inputs[7].resumeStopEpoch = resumeEpoch;
      const f = fixture(); f.bridge.restore(cut);
      for (const run of ["legacy-run-7", "legacy-run-8", "legacy-run-9"]) f.proofs.set(run, { status: "completed" });
      try {
        expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
        expect(f.bridge.capture().records[0].stopInputRevision).toBe(7);
        expect(await f.bridge.messageReceipt("root", "legacy-input-7")).toMatchObject({ status: "unknown", stopResolved: true });
        for (const id of ["legacy-input-8", "legacy-input-9"]) expect((await f.bridge.messageReceipt("root", id))?.stopResolved).not.toBe(true);
        const restart = fixture(); restart.bridge.restore(f.bridge.capture());
        for (const run of ["legacy-run-8", "legacy-run-9"]) restart.proofs.set(run, { status: "completed" });
        try {
          expect(await restart.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
          expect(restart.bridge.capture().records[0].stopInputRevision).toBe(7);
          expect(await restart.bridge.stopConversation("root")).toMatchObject({ status: "cancelled", canSend: true });
          expect(restart.bridge.capture().records[0]).toMatchObject({ stopEpoch: 2, stopInputRevision: 9 });
          for (const id of ["legacy-input-7", "legacy-input-8", "legacy-input-9"]) expect(await restart.bridge.messageReceipt("root", id)).toMatchObject({ status: "unknown", stopResolved: true });
          expect(restart.facade.continueMessage).not.toHaveBeenCalled();
        } finally { restart.bridge.dispose(); }
        expect(f.facade.continueMessage).not.toHaveBeenCalled();
      } finally { f.bridge.dispose(); }
    });
    it("preserves an existing explicit boundary instead of expanding it during restore", async () => {
      const cut = await legacyCut(); cut.records[0].stopInputRevision = 7;
      const f = fixture(); f.bridge.restore(cut); f.proofs.set("legacy-run-8", { status: "completed" });
      try {
        expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
        expect(f.bridge.capture().records[0].stopInputRevision).toBe(7);
        expect((await f.bridge.messageReceipt("root", "legacy-input-8"))?.stopResolved).not.toBe(true);
        expect(f.facade.continueMessage).not.toHaveBeenCalled();
      } finally { f.bridge.dispose(); }
    });
  });
  it("persists resolved unknown history across restart without losing the stop watch or accepting a late child", async () => {
    const original = fixture();
    original.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await original.bridge.sendMessage(message); await original.bridge.drain();
    original.proofs.set("follow-run", { status: "completed" });
    await original.bridge.stopConversation("root");
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(); f.bridge.restore(cut);
    try {
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "cancelled", canSend: true, deliveries: [{ status: "unknown", stopResolved: true }] });
      f.branches.push({ id: "late", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
        engine: "codex", sessionId: "late-child", workspacePath: f.ref.workspacePath, state: "running" });
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "stopping", canSend: false, canChangeSelection: false });
      f.branches[0].state = "stopped";
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "cancelled", canSend: true });
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { f.bridge.dispose(); }
  });
  it("does not release an unknown input without an explicit stop, or one accepted after the stop boundary", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      f.proofs.set("follow-run", { status: "completed" });
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect((await f.bridge.messageReceipt("root", message.requestId))?.stopResolved).not.toBe(true);
      const cut = f.bridge.capture();
      cut.records[0].stopping = true; cut.records[0].stopRunId = "follow-run"; cut.records[0].stopEpoch = 1;
      Object.assign(cut.records[0], { stopInputRevision: 0 });
      f.bridge.restore(cut);
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect((await f.bridge.messageReceipt("root", message.requestId))?.stopResolved).not.toBe(true);
      expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    } finally { f.bridge.dispose(); }
  });
  it("requires all owned children to settle even after the unknown input's stop fence is resolved", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      f.branches.push({ id: "child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId,
        engine: "codex", sessionId: "child", workspacePath: f.ref.workspacePath, state: "unknown" });
      f.proofs.set("follow-run", { status: "completed" });
      const view = await f.bridge.stopConversation("root");
      expect(view).toMatchObject({ status: "unknown", canSend: false, canChangeSelection: false,
        deliveries: [{ status: "unknown", stopResolved: true }], children: [{ state: "unknown" }] });
      await expect(f.bridge.sendMessage({ ...message, requestId: "new-input", expectedInputRevision: 1 })).rejects.toThrow("cannot accept");
      expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    } finally { f.bridge.dispose(); }
  });
  it("recovers the exact stopped input run in the background without replaying the input", async () => {
    const original = fixture(); await original.bridge.sendMessage(message); await original.bridge.drain();
    const cut = original.bridge.capture(); original.bridge.dispose();
    const f = fixture(); f.bridge.restore(cut);
    const gate = deferred<{ status: "completed" }>(); f.facade.recoverSettledRun.mockReturnValue(gate.promise);
    try {
      await f.bridge.stopConversation("root");
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect(f.facade.recoverSettledRun).toHaveBeenCalledExactlyOnceWith("follow-run", f.ref, { inputOnly: true });
      gate.resolve({ status: "completed" });
      await vi.waitFor(async () => expect(await f.bridge.conversation("root")).toMatchObject({ status: "cancelled", canSend: true,
        deliveries: [{ status: "unknown", stopResolved: true }] }));
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    } finally { gate.resolve({ status: "completed" }); f.bridge.dispose(); }
  });
  it("keeps a failed stop-resolution write fenced and never publishes a false cancellation", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    const seen: string[] = []; f.bridge.onConversationEvent(view => seen.push(view.status));
    try {
      await f.bridge.sendMessage(message); await f.bridge.drain();
      f.proofs.set("follow-run", { status: "completed" });
      const write = f.deps.storage.set;
      f.deps.storage.set = async (plugin, key, value) => {
        if ((value as any).records[0]?.inputs[0]?.receipt.stopResolved) throw new Error("disk unavailable");
        await write(plugin, key, value);
      };
      await expect(f.bridge.stopConversation("root")).rejects.toThrow("persistence");
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
      expect(seen).not.toContain("cancelled");
      expect(f.deps.hold).toHaveBeenLastCalledWith("root", true);
    } finally { f.bridge.dispose(); }
  });
  it("keeps proven historical stop resolution when a later run's write fails and recovery can only prove that later run", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.proofs.set("follow-run", { status: "completed" });
    await f.bridge.stopConversation("root");
    f.deps.runId = () => "later-run";
    await f.bridge.sendMessage({ ...message, requestId: "later-input", expectedInputRevision: 1 }); await f.bridge.drain();
    const write = f.deps.storage.set; let fail = true;
    f.deps.storage.set = async (plugin, key, value) => {
      if (fail) { fail = false; throw new Error("unrelated write failure"); }
      await write(plugin, key, value);
    };
    await expect(f.bridge.messageReceipt("root", "later-input")).rejects.toThrow("persistence");
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false });
    f.bridge.dispose();
    const next = fixture(f.saved);
    Object.assign(next.facade, { canProjectTerminalRun: (run: string) => run === "later-run" });
    next.proofs.set("later-run", { status: "cancelled" });
    try {
      expect(await next.bridge.stopConversation("root")).toMatchObject({ status: "cancelled", canSend: true,
        deliveries: [{ requestId: message.requestId, status: "unknown", stopResolved: true },
          { requestId: "later-input", status: "unknown", stopResolved: true }] });
      expect(next.facade.continueMessage).not.toHaveBeenCalled();
    } finally { next.bridge.dispose(); }
  });
  it("persists acceptance and delivery fences before acknowledging or calling native", async () => {
    const f = fixture();
    const original = f.facade.continueMessage.getMockImplementation()!;
    f.facade.continueMessage.mockImplementationOnce(async (...args) => {
      const disk = f.saved.get("__host_tasks_v1:conversations") as any;
      expect(disk.records[0].inputs[0].receipt.status).toBe("queued");
      const fence = args[4]; args[4] = async (delivery: string, run: string) => {
        await fence(delivery, run);
        expect((f.saved.get("__host_tasks_v1:conversations") as any).records[0].inputs[0].receipt.status).toBe("starting");
      };
      return original(...args);
    });
    await f.bridge.sendMessage(message); await f.bridge.drain(); f.bridge.dispose();
  });
  it("rejects stale displayed actions and freezes stable native row projections", async () => {
    const f = fixture();
    const a = await f.bridge.conversation("root"); const b = await f.bridge.conversation("root");
    expect(a).toBe(b); expect(a.messages[0]).toBe(b.messages[0]); expect(a.messages[0]).not.toBe(f.state.messages[0]);
    expect(Object.isFrozen(a.messages[0])).toBe(true);
    f.state.messages = [...f.state.messages, { seq: 2, role: "assistant", text: "中文😀", ts: null }];
    await expect(f.bridge.conversationAction("root", { type: "openNative", conversationRequestId: "root", expectedRevision: a.revision })).rejects.toThrow("Stale");
    expect(f.facade.conversationAction).not.toHaveBeenCalled();
    const c = await f.bridge.conversation("root"); expect(c.messages[0]).toBe(a.messages[0]);
    await expect(f.bridge.conversationAction("root", { type: "openNative", conversationRequestId: "other-source", expectedRevision: c.revision })).rejects.toThrow("Stale");
    await f.bridge.conversationAction("root", { type: "openNative", conversationRequestId: "root", expectedRevision: c.revision });
    expect(f.facade.conversationAction).toHaveBeenCalledOnce(); f.bridge.dispose();
  });
  it("keeps a queued input bounded and serializes simultaneous CAS acceptance", async () => {
    const f = fixture(); f.state.canDeliver = false;
    const results = await Promise.allSettled([f.bridge.sendMessage(message), f.bridge.sendMessage({ ...message, requestId: "rival" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (let i = 1; i < 32; i++) await f.bridge.sendMessage({ ...message, requestId: `input-${i}`, expectedInputRevision: i });
    await expect(f.bridge.sendMessage({ ...message, requestId: "overflow", expectedInputRevision: 32 })).rejects.toThrow("limit");
    expect(f.facade.continueMessage).not.toHaveBeenCalled(); f.bridge.dispose();
  });
  it("cancels pending input while preparation is awaiting and never resurrects it", async () => {
    const f = fixture(); let resolve!: (paths: string[]) => void;
    f.deps.resolveImages = () => new Promise<string[]>(r => { resolve = r; });
    await f.bridge.sendMessage(message);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const stopped = await f.bridge.stopConversation("root");
    expect(stopped.deliveries[0].status).toBe("cancelled");
    resolve([]); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("cancelled");
    expect((await f.bridge.conversation("root")).status).toBe("cancelled"); f.bridge.dispose();
  });
  it("requests stop immediately and again after a late native ACK without claiming terminal early", async () => {
    const f = fixture(); let acknowledge!: () => void;
    f.facade.continueMessage.mockImplementationOnce(async (_ref, _text, _images, run, fence) => {
      await fence("turn", run); f.state.runId = run; f.state.status = "busy"; f.state.canDeliver = false;
      await new Promise<void>(r => { acknowledge = r; }); return { delivery: "turn", runId: run };
    });
    await f.bridge.sendMessage(message); await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    const stopping = await f.bridge.stopConversation("root");
    expect(stopping.status).not.toBe("cancelled"); expect(f.facade.interrupt).toHaveBeenCalledWith("follow-run");
    acknowledge(); await f.bridge.drain();
    expect(f.facade.interrupt).toHaveBeenCalledTimes(2);
    expect((await f.bridge.conversation("root")).status).toBe("stopping");
    f.proofs.set("follow-run", { status: "cancelled" }); f.state.runId = null; f.state.status = "idle";
    expect((await f.bridge.conversation("root")).status).toBe("cancelled"); f.bridge.dispose();
  });
  it("does not wait for a never-started run when stop races the input's starting fence", async () => {
    const f = fixture(), gate = deferred<void>(), fenced = deferred<void>();
    const write = f.deps.storage.set;
    f.deps.storage.set = async (plugin, key, value) => {
      await write(plugin, key, value);
      if ((value as any).records[0]?.inputs[0]?.receipt.status === "starting") { fenced.resolve(); await gate.promise; }
    };
    f.facade.continueMessage.mockImplementationOnce(async (_ref, _text, _images, run, fence) => {
      await fence("turn", run); throw new TaskPreSpawnError("selection changed before spawn");
    });
    try {
      await f.bridge.sendMessage(message); await fenced.promise;
      const stop = f.bridge.stopConversation("root");
      await vi.waitFor(() => expect(f.bridge.capture().records[0].stopping).toBe(true));
      expect(f.bridge.capture().records[0].stopRunId).toBeUndefined();
      gate.resolve(); await stop; await f.bridge.drain();
      expect(await f.bridge.conversation("root")).toMatchObject({ status: "cancelled", canSend: true,
        deliveries: [{ status: "cancelled" }] });
      expect(f.facade.interrupt).not.toHaveBeenCalled();
    } finally { gate.resolve(); f.bridge.dispose(); }
  });
  it("refuses durable acceptance when storage fails and returns no false queued acknowledgement on retry", async () => {
    const f = fixture(); await f.bridge.conversation("root");
    f.deps.storage.set = async () => { throw new Error("disk failed"); };
    await expect(f.bridge.sendMessage(message)).rejects.toThrow(/persistence/i);
    expect((await f.bridge.sendMessage(message)).status).toBe("unknown");
    expect(f.facade.continueMessage).not.toHaveBeenCalled(); f.bridge.dispose();
  });
  it("recovers a checkpoint's original input IDs and received native settlement", async () => {
    const f = fixture(); await f.bridge.sendMessage(message); await f.bridge.drain();
    const cut = f.bridge.capture(); f.bridge.dispose();
    const next = fixture(); next.proofs.set("follow-run", { status: "completed" }); next.bridge.restore(cut);
    const receipt = await next.bridge.messageReceipt("root", "input-one");
    expect(receipt).toMatchObject({ status: "completed", runId: "follow-run", inputRevision: 1 });
    expect(next.facade.continueMessage).not.toHaveBeenCalled(); next.bridge.dispose();
  });
  it("rejects a corrupted persistent input fingerprint instead of dispatching it", async () => {
    const f = fixture(); f.state.canDeliver = false; await f.bridge.sendMessage(message);
    const cut = f.bridge.capture(); f.bridge.dispose(); cut.records[0].inputs[0].prompt = "forged";
    const next = fixture(); expect(() => next.bridge.restore(cut)).toThrow("input fence"); next.bridge.dispose();
  });
  it("accepts an explicit new same-session input after native stop has really settled", async () => {
    const f = fixture();
    expect(await f.bridge.stopConversation("root")).toMatchObject({ status: "cancelled", canSend: true });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    expect(f.facade.continueMessage.mock.calls[0][0]).toEqual(f.ref); f.bridge.dispose();
  });
  it("reports a proven native failure while keeping the same idle session available for an explicit new input", async () => {
    const f = fixture();
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.proofs.set("follow-run", { status: "failed" }); f.state.runId = null; f.state.status = "idle"; f.state.canDeliver = true;
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "failed", canSend: true, canChangeSelection: true });
    await f.bridge.sendMessage({ ...message, requestId: "explicit-next", expectedInputRevision: 1 });
    expect((await f.bridge.messageReceipt("root", "explicit-next"))?.sessionRef).toEqual(f.ref); f.bridge.dispose();
  });
  it("does not enter native delivery if the owner disappears while the fence is persisting", async () => {
    const f = fixture(); const write = f.deps.storage.set;
    let release!: () => void; let nativeSent = false;
    f.deps.storage.set = async (owner, key, value) => {
      await write(owner, key, value);
      if ((value as any)?.records?.[0]?.inputs?.[0]?.receipt.status === "starting") await new Promise<void>(r => { release = r; });
    };
    f.facade.continueMessage.mockImplementationOnce(async (_ref, _text, _images, run, fence) => {
      await fence("turn", run); nativeSent = true; return { delivery: "turn", runId: run };
    });
    await f.bridge.sendMessage(message); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.bridge.dispose(); release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(nativeSent).toBe(false);
    const restored = fixture(f.saved);
    expect((await restored.bridge.messageReceipt("root", "input-one"))?.status).toBe("unknown");
    expect(restored.facade.continueMessage).not.toHaveBeenCalled(); restored.bridge.dispose();
  });
});
