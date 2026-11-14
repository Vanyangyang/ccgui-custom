import { afterEach, describe, expect, it, vi } from "vitest";
import { approveCrossSessionMessage, cancelCrossSessionMessage, useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "@/features/chat/cross-session";
import { prepareCrossSessionHandoff } from "@/features/chat/cross-session-handoff";
import { resolveLeaderCostApproval } from "@/features/leader/cost-approval";
import { captureTaskCostApproval, loadTaskCostContext, projectTaskCostApprovals, resolveTaskCostApproval, taskCostApprovalsChanged, taskCostContextVersion } from "./task-cost-review";
import { ipc, type SessionMeta, type SessionPage } from "@/lib/ipc";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";

vi.mock("@/lib/ipc", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/ipc")>(), ipc: { ...((await importOriginal<typeof import("@/lib/ipc")>()).ipc), loadSessionPage: vi.fn() } }));

vi.mock("@/features/chat/cross-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/chat/cross-session")>(),
  approveCrossSessionMessage: vi.fn(), cancelCrossSessionMessage: vi.fn(),
}));
vi.mock("@/features/chat/cross-session-handoff", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/chat/cross-session-handoff")>(), prepareCrossSessionHandoff: vi.fn(),
}));
vi.mock("@/features/leader/cost-approval", () => ({ resolveLeaderCostApproval: vi.fn() }));

const sender = { engine: "codex", sessionId: "root", workspacePath: "G:/project" };
const target = { engine: "agy", sessionId: "target", workspacePath: "G:/project" };
const record = (overrides: Partial<CrossSessionCommunicationRecord> = {}): CrossSessionCommunicationRecord => ({
  scopedId: "cost-1", requestId: "request-1", sender, target, message: "待讨论🙂", status: "awaiting_cost_approval", acceptedAt: 1, updatedAt: 1, ...overrides,
});

afterEach(() => { useCrossSessionActivityStore.getState().reset(); useChatStore.setState({ sessions: [], bySession: {}, openTabs: [], archivedSessionKeys: {} }); vi.clearAllMocks(); });

const expectNoDecision = () => {
  expect(approveCrossSessionMessage).not.toHaveBeenCalled();
  expect(cancelCrossSessionMessage).not.toHaveBeenCalled();
  expect(prepareCrossSessionHandoff).not.toHaveBeenCalled();
  expect(resolveLeaderCostApproval).not.toHaveBeenCalled();
};

describe("task cost review projection", () => {
  it("captures frozen image identities and rejects same-text replacement or reordering", async () => {
    const refs = ["a", "b"].map(sha => `task-image:${sha.repeat(64)}`);
    const held = record({ leaderCostApproval: { branchId: "branch", requestId: "held" }, imageRefs: refs });
    const store = useCrossSessionActivityStore.getState(); store.upsertRecord(held);
    const expected = projectTaskCostApprovals([sender]).items[0], captured = captureTaskCostApproval([sender], expected);
    expect(captured.imageRefs).toEqual(refs); expect(captured.imageRefs).not.toBe(refs); expect(Object.isFrozen(captured.imageRefs)).toBe(true);
    expect(Object.isFrozen(expected.imageRefs)).toBe(true);
    expect(expected.requestEstimate).toMatchObject({ imageCount: 2 });
    const changed = { ...held, imageRefs: [...refs].reverse() };
    expect(taskCostApprovalsChanged([changed], [held])).toBe(true); store.upsertRecord(changed);
    expect(() => captureTaskCostApproval([sender], expected)).toThrow("changed");
    await expect(resolveTaskCostApproval([sender], expected, "approve")).rejects.toThrow("changed");
    expectNoDecision();
  });
  it("invalidates a confirmation when verified pricing crosses its effective date, while cancellation remains available", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 30, 23, 59, 59));
    try {
      const held = record({ leaderCostApproval: { branchId: "branch", requestId: "held", model: "gemini-4-argon" },
        costReview: { capturedAt: Date.now(), model: "gemini-4-argon", cacheHeat: "unknown", targetStatus: "idle",
          context: { used: 326963, kind: "last_request", capacityKnown: false, reference: false, modelMismatch: false } } });
      useCrossSessionActivityStore.getState().upsertRecord(held);
      const expected = projectTaskCostApprovals([sender]).items[0];
      expect(expected.requestEstimate?.pricing?.inputUsdPerMillion).toBe(2);
      vi.setSystemTime(Date.UTC(2026, 11, 1));
      expect(projectTaskCostApprovals([sender]).items[0].requestEstimate?.pricing?.inputUsdPerMillion).toBe(4);
      await expect(resolveTaskCostApproval([sender], expected, "approve", held.message)).rejects.toThrow("Cost evidence changed");
      expect(resolveLeaderCostApproval).not.toHaveBeenCalled();
      await resolveTaskCostApproval([sender], expected, "cancel", held.message);
      expect(resolveLeaderCostApproval).toHaveBeenCalledExactlyOnceWith(held, false);
    } finally { vi.useRealTimers(); }
  });
  it("shows only requests sent by an owned exact session and bounds text and count", () => {
    const owned = record({ message: "🙂".repeat(1201) });
    const unrelated = record({ scopedId: "other", sender: { ...sender, workspacePath: "G:/different" }, target: sender });
    const rows = [owned, unrelated, ...Array.from({ length: 32 }, (_, i) => record({ scopedId: `cost-${i + 2}` }))];
    const result = projectTaskCostApprovals([sender], rows);
    expect(result.items).toHaveLength(32); expect(result.truncated).toBe(true);
    expect(result.items.some(item => item.id === "other")).toBe(false);
    expect(Array.from(result.items[0].message)).toHaveLength(1200);
    expect(result.items[0].truncated).toBe(true);
  });

  it("refuses a changed or no-longer-owned request after a human confirmation", async () => {
    const store = useCrossSessionActivityStore.getState(); store.upsertRecord(record());
    const expected = projectTaskCostApprovals([sender]).items[0];
    store.upsertRecord(record({ message: "different request" }));
    await expect(resolveTaskCostApproval([sender], expected, "approve")).rejects.toThrow("changed");
    await expect(resolveTaskCostApproval([{ ...sender, workspacePath: "G:/other" }], expected, "cancel")).rejects.toThrow("changed");
    expect(useCrossSessionActivityStore.getState().records[0].status).toBe("awaiting_cost_approval");
  });

  it("does not wake for changes unrelated to pending cost reviews", () => {
    const held = record(), done = record({ scopedId: "done", status: "completed" });
    expect(taskCostApprovalsChanged([held, { ...done, replyText: "new text" }], [held, done])).toBe(false);
    expect(taskCostApprovalsChanged([{ ...held, message: "updated" }], [held])).toBe(true);
  });

  it.each([false, true])("captures the untouched full message and exact target without acting (leader=%s)", (leader) => {
    const original = record({ message: "🙂".repeat(1200) + "\r\n尾部\u0000", target: { ...target, workspacePath: "G:/Project/精确路径", title: "Target" },
      ...(leader ? { leaderCostApproval: { branchId: "branch", requestId: "leader-request" } } : {}) });
    useCrossSessionActivityStore.getState().upsertRecord(original);
    const expected = projectTaskCostApprovals([sender]).items[0];
    const snapshot = captureTaskCostApproval([sender], expected);
    expect(snapshot).toEqual({ approval: expected, message: original.message, imageRefs: [], kind: leader ? "leader" : "cross-session" });
    expect(snapshot.approval.kind).toBe(leader ? "leader" : "crossSession");
    expect(snapshot.approval.target).toEqual(original.target);
    expect(snapshot.approval.truncated).toBe(true);
    expect(useCrossSessionActivityStore.getState().records[0]).toEqual(original);
    expectNoDecision();
  });

  it.each(["approve", "cancel", "handoff"] as const)("rejects changed full-message tails before %s", async (decision) => {
    const store = useCrossSessionActivityStore.getState();
    store.upsertRecord(record({ message: "🙂".repeat(1200) + "original tail" }));
    const snapshot = captureTaskCostApproval([sender], projectTaskCostApprovals([sender]).items[0]);
    // Keep excerpt and size equal; only the full-message check can catch this.
    store.upsertRecord(record({ message: "🙂".repeat(1200) + "changed tail!" }));
    expect(projectTaskCostApprovals([sender]).items[0]).toEqual(snapshot.approval);
    await expect(resolveTaskCostApproval([sender], snapshot.approval, decision, snapshot.message)).rejects.toThrow("changed");
    expectNoDecision();
  });

  it.each([
    { requestId: "changed" }, { status: "completed" },
    { sender: { ...sender, engine: "claude" } }, { sender: { ...sender, sessionId: "other" } }, { sender: { ...sender, workspacePath: "G:/other" } },
    { target: { ...target, engine: "claude" } }, { target: { ...target, sessionId: "other" } }, { target: { ...target, workspacePath: "G:/other" } },
  ] satisfies Partial<CrossSessionCommunicationRecord>[])("rejects changed identity or pending state: %j", async (change) => {
    const store = useCrossSessionActivityStore.getState(); store.upsertRecord(record());
    const snapshot = captureTaskCostApproval([sender], projectTaskCostApprovals([sender]).items[0]);
    store.upsertRecord(record(change));
    expect(() => captureTaskCostApproval([sender], snapshot.approval)).toThrow("changed");
    await expect(resolveTaskCostApproval([sender], snapshot.approval, "cancel", snapshot.message)).rejects.toThrow("changed");
    expectNoDecision();
  });

  it("rejects lost ownership when capturing or resolving", async () => {
    useCrossSessionActivityStore.getState().upsertRecord(record());
    const snapshot = captureTaskCostApproval([sender], projectTaskCostApprovals([sender]).items[0]);
    expect(() => captureTaskCostApproval([], snapshot.approval)).toThrow("changed");
    await expect(resolveTaskCostApproval([], snapshot.approval, "cancel", snapshot.message)).rejects.toThrow("changed");
    expectNoDecision();
  });

  it("keeps legacy resolution without a full-message snapshot compatible", async () => {
    const store = useCrossSessionActivityStore.getState();
    store.upsertRecord(record({ message: "a".repeat(1200) + "old" }));
    const expected = projectTaskCostApprovals([sender]).items[0];
    store.upsertRecord(record({ message: "a".repeat(1200) + "new" }));
    await resolveTaskCostApproval([sender], expected, "approve");
    expect(approveCrossSessionMessage).toHaveBeenCalledExactlyOnceWith("cost-1", undefined, null);
  });

  it.each([
    { leader: false, decision: "approve" }, { leader: false, decision: "cancel" }, { leader: false, decision: "handoff" },
    { leader: true, decision: "approve" }, { leader: true, decision: "cancel" },
  ] as const)("dispatches an unchanged full-message snapshot: %j", async ({ leader, decision }) => {
    const original = record({ ...(leader ? { leaderCostApproval: { branchId: "branch", requestId: "leader-request" } } : {}) });
    useCrossSessionActivityStore.getState().upsertRecord(original);
    const snapshot = captureTaskCostApproval([sender], projectTaskCostApprovals([sender]).items[0]);
    await resolveTaskCostApproval([sender], snapshot.approval, decision, snapshot.message);
    if (leader) expect(resolveLeaderCostApproval).toHaveBeenCalledExactlyOnceWith(original, decision === "approve");
    else if (decision === "handoff") expect(prepareCrossSessionHandoff).toHaveBeenCalledExactlyOnceWith(original);
    else if (decision === "approve") expect(approveCrossSessionMessage).toHaveBeenCalledExactlyOnceWith(original.scopedId, undefined, null);
    else expect(cancelCrossSessionMessage).toHaveBeenCalledExactlyOnceWith(original.scopedId);
  });
});

describe("task cost context telemetry", () => {
  const child = { ...target, engine: "claude" };
  const key = sessionKey(child.engine, child.sessionId, child.workspacePath);
  const usage = { input_tokens: 1234, context_window: 200000 };
  const page = (model = "locked") => ({ messages: [{ model, usage }], nextBefore: null, subagentHistory: [] }) as unknown as SessionPage;
  function fixture(loaded = false) {
    const meta = { ...child, model: "other-selected", filePath: "/target.jsonl", promptCache: null } as SessionMeta;
    const held = record({ target: child, leaderCostApproval: { branchId: "branch", requestId: "held", model: "locked" }, costReview: {
      capturedAt: 10, cacheHeat: "cold", model: "locked", targetStatus: "idle",
      cache: { startedAt: 1, observedAt: 2, ttlSeconds: 300, source: "anthropic-usage", reference: { promptTokens: 0, cacheReadTokens: 0, maxTtlSeconds: 3600 } },
      context: { kind: "unknown", capacityKnown: false, reference: false, modelMismatch: false },
    } });
    useCrossSessionActivityStore.getState().upsertRecord(held);
    useChatStore.setState({ sessions: [meta], openTabs: [], archivedSessionKeys: {}, bySession: loaded ? { [key]: { ...EMPTY_SESSION, usage, messages: page().messages } } : {} });
    return { meta, held, expected: projectTaskCostApprovals([sender]).items[0] };
  }

  it("versions only the exact saved history source and its availability, never live text or other chats", () => {
    const { meta } = fixture();
    const initial = taskCostContextVersion(child);
    useChatStore.setState({ sessions: [{ ...meta, title: "new title", preview: "new preview", workspacePath: "G:\\project" },
      { ...meta, sessionId: "another", fileMtimeMs: 999 }],
      bySession: { [key]: { ...EMPTY_SESSION, messages: [{ seq: 1, text: "streaming delta" }] as never } } });
    expect(taskCostContextVersion(child)).toBe(initial);
    useChatStore.setState({ sessions: [{ ...meta, fileMtimeMs: 123 }] });
    expect(taskCostContextVersion(child)).not.toBe(initial);
    useChatStore.setState({ sessions: [meta], archivedSessionKeys: { [key]: true } });
    expect(taskCostContextVersion(child)).not.toBe(initial);
    useChatStore.setState({ sessions: [meta, { ...meta, workspacePath: "G:/other" }], archivedSessionKeys: {} });
    const ambiguous = taskCostContextVersion(child);
    expect(ambiguous).not.toBe(initial);
    useChatStore.setState({ sessions: [meta, { ...meta, workspacePath: "G:/other", fileMtimeMs: 456 }] });
    expect(taskCostContextVersion(child)).toBe(ambiguous);
  });

  it("changes the source version when absent exact metadata arrives and permits a read of the same held request", async () => {
    const { meta, expected } = fixture();
    useChatStore.setState({ sessions: [] });
    const missing = taskCostContextVersion(child);
    expect(await loadTaskCostContext([sender], expected)).toBeNull();
    expect(ipc.loadSessionPage).not.toHaveBeenCalled();
    useChatStore.setState({ sessions: [meta] });
    expect(taskCostContextVersion(child)).not.toBe(missing);
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce(page());
    expect(await loadTaskCostContext([sender], expected)).toMatchObject({ id: expected.id, requestId: expected.requestId, used: 1234 });
    expectNoDecision();
  });

  it("samples a loaded exact target using its held model and retains zero-valued held cache evidence", () => {
    const { expected } = fixture(true);
    expect(expected).toMatchObject({ model: "locked", used: 1234, usageKind: "current_context", modelMismatch: false,
      usageModel: "locked", cacheHeat: "unknown", cacheReference: { promptTokens: 0, cacheReadTokens: 0, observedAt: 2, ttlSeconds: 300, maxTtlSeconds: 3600 } });
    expect(ipc.loadSessionPage).not.toHaveBeenCalled();
    expect(expected.capturedAt).toBe(10);
    expect(projectTaskCostApprovals([sender]).items[0]).toEqual(expected);
  });

  it("does not offer a Handoff when a loaded target awaits a human permission", () => {
    fixture(true);
    const session = useChatStore.getState().bySession[key];
    useChatStore.setState({ bySession: { [key]: { ...session,
      messages: [...session.messages, { seq: 2, role: "assistant", text: "", ts: null, grant: { status: "pending" } } as never] } } });
    expect(projectTaskCostApprovals([sender]).items[0].canHandoff).toBe(false);
  });

  it("does not borrow loaded usage when the native engine/session identity conflicts across workspaces", () => {
    const { meta } = fixture(true);
    useChatStore.setState({ sessions: [meta, { ...meta, workspacePath: "G:/other" }] });
    expect(projectTaskCostApprovals([sender]).items[0]).toMatchObject({ usageKind: "unknown" });
    expect(projectTaskCostApprovals([sender]).items[0].used).toBeUndefined();
  });

  it("does not borrow loaded usage from a conflicting open tab whose session key omits workspace", () => {
    fixture(true);
    useChatStore.setState({ openTabs: [{ ...child, workspacePath: "G:/other" }] });
    expect(projectTaskCostApprovals([sender]).items[0]).toMatchObject({ usageKind: "unknown" });
    expect(projectTaskCostApprovals([sender]).items[0].used).toBeUndefined();
  });

  it("discards a history read if a conflicting open tab appears before it returns", async () => {
    const { expected } = fixture();
    const initial = taskCostContextVersion(child);
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(async () => {
      useChatStore.setState({ openTabs: [{ ...child, workspacePath: "G:/other" }] });
      return page();
    });
    expect(await loadTaskCostContext([sender], expected)).toBeNull();
    expect(taskCostContextVersion(child)).not.toBe(initial);
    expectNoDecision();
  });

  it("loads unopened/loading history without changing store, tabs, cache or request identity", async () => {
    const { expected } = fixture();
    let finish!: (value: SessionPage) => void;
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const state = useChatStore.getState();
    const pending = loadTaskCostContext([sender], expected);
    expect(projectTaskCostApprovals([sender]).items[0].usageKind).toBe("unknown");
    finish(page());
    const result = await pending;
    expect(result).toMatchObject({ ...expected, used: 1234, max: 200000, usageKind: "current_context", usageModel: "locked", modelMismatch: false,
      requestEstimate: { ...expected.requestEstimate, contextBasis: "current_context", contextTokens: 1234,
        inputTokens: { lower: 1238, upper: 1247 }, displayLines: expect.arrayContaining([expect.stringContaining("1,238–1,247")]) } });
    expect(useChatStore.getState()).toBe(state);
    expect(ipc.loadSessionPage).toHaveBeenCalledExactlyOnceWith("claude", "target", 100);
    expectNoDecision();
  });

  it("labels different-model history as last request and ignores trailing error usage", async () => {
    const { expected } = fixture();
    const history = page("older-model");
    history.messages.push({ model: "locked", usage: {} } as never);
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce(history);
    expect(await loadTaskCostContext([sender], expected)).toMatchObject({ used: 1234, usageKind: "last_request", usageModel: "older-model", modelMismatch: true });
  });

  it.each(["other-workspace", "ambiguous", "archived", "remote"])("does not read %s metadata", async condition => {
    const { expected, meta } = fixture();
    if (condition === "other-workspace") useChatStore.setState({ sessions: [{ ...meta, workspacePath: "G:/elsewhere" }] });
    if (condition === "ambiguous") useChatStore.setState({ sessions: [meta, { ...meta, workspacePath: "G:/elsewhere" }] });
    if (condition === "archived") useChatStore.setState({ archivedSessionKeys: { [key]: true } });
    if (condition === "remote") useChatStore.setState({ sessions: [{ ...meta, remote: true }] });
    expect(await loadTaskCostContext([sender], expected)).toBeNull();
    expect(ipc.loadSessionPage).not.toHaveBeenCalled();
  });

  it.each(["metadata", "full-message-tail"])("rejects a late result after changing %s", async condition => {
    const { held, meta } = fixture();
    useCrossSessionActivityStore.getState().upsertRecord({ ...held, message: "a".repeat(1200) + "before" });
    const expected = projectTaskCostApprovals([sender]).items[0];
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(async () => {
      if (condition === "metadata") useChatStore.setState({ sessions: [{ ...meta, workspacePath: "G:/other" }] });
      else useCrossSessionActivityStore.getState().upsertRecord({ ...held, message: "a".repeat(1200) + "after" });
      return page();
    });
    expect(await loadTaskCostContext([sender], expected)).toBeNull();
  });

  it("keeps missing/error history unknown and exposes read failure without sending", async () => {
    const { expected } = fixture();
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ messages: [], nextBefore: null, subagentHistory: [] });
    expect(await loadTaskCostContext([sender], expected)).toBeNull();
    vi.mocked(ipc.loadSessionPage).mockRejectedValueOnce(new Error("unreadable"));
    await expect(loadTaskCostContext([sender], expected)).rejects.toThrow("unreadable");
    expect(projectTaskCostApprovals([sender]).items[0].usageKind).toBe("unknown");
    expectNoDecision();
  });

  it.each([NaN, Infinity, -1, 1])("omits invalid cache read reference %s", value => {
    const { held } = fixture();
    held.costReview!.cache!.reference!.cacheReadTokens = value;
    expect(projectTaskCostApprovals([sender], [held]).items[0].cacheReference).toBeUndefined();
  });
  it("omits a cache reference with an invalid retention window", () => {
    const { held } = fixture(); held.costReview!.cache!.ttlSeconds = 0;
    expect(projectTaskCostApprovals([sender], [held]).items[0].cacheReference).toBeUndefined();
  });
});
