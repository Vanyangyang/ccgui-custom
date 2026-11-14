import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CrossSessionCostApproval, SessionSendCostApproval } from "./CrossSessionCostApproval";
import { CrossSessionQueue } from "./CrossSessionQueue";
import { useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "../cross-session";
import { useSessionSendCostGuardStore } from "../cross-session-cost";
import { useHandoffStore } from "../session-cleanup";
import type { ActiveSession } from "../store";
import type { ChatStore } from "../store/types";
import type { SessionMeta } from "@/lib/ipc";
import { EMPTY_SESSION } from "../store/stream";
import { sessionKey } from "../store/persistence";
import { webcrypto } from "node:crypto";
import type { ManagedChildTargetPickerProps } from "./ManagedChildTargetPicker";

const actions = vi.hoisted(() => ({ approve: vi.fn(), cancel: vi.fn(), send: vi.fn() }));
const native = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/transport", () => ({ invoke: native.invoke, isWeb: false, listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
// Model catalog and menu rendering have dedicated component/browser coverage.
// This integration retains the actual summary service and native cost actions.
vi.mock("./HandoffCompressionControls", () => ({ HandoffModelPicker: () => null }));
vi.mock("./ManagedChildTargetPicker", () => ({ ManagedChildTargetPicker: ({ onChange, disabled, supported }: ManagedChildTargetPickerProps) =>
  <button data-testid="target-picker" disabled={disabled || !supported} onClick={() => onChange({ engine: "codex", model: "gpt-6-astra", providerId: "__local__", effort: "high" })}>target</button> }));
vi.mock("@/features/leader/store", () => ({ useLeaderStore: { getState: () => ({ refresh: native.refresh }) } }));
vi.mock("../cross-session", async (original) => ({
  ...await original<typeof import("../cross-session")>(),
  approveCrossSessionMessage: actions.approve,
  cancelCrossSessionMessage: actions.cancel,
  sendCrossSessionMessageNow: actions.send,
}));
const chat = vi.hoisted(() => ({ sessions: [] as SessionMeta[], setSessionError: vi.fn(), setDraft: vi.fn(), removeQueued: vi.fn(), sendQueuedNow: vi.fn(),
  bySession: {} as ChatStore["bySession"], openTabs: [] as ActiveSession[], models: {}, archivedSessionKeys: {} as Record<string, boolean> }));
vi.mock("../store", async () => ({
  useChatStore: Object.assign((selector: (state: typeof chat) => unknown) => selector(chat), { getState: () => chat }),
  sessionKey: (await import("../store/persistence")).sessionKey,
}));
const sender = { engine: "codex", sessionId: "sender", workspacePath: "/ws", title: "Sender" };
const target = { engine: "claude", sessionId: "target", workspacePath: "/ws", title: "Target" };
const record = (): CrossSessionCommunicationRecord => ({
  scopedId: "approval-1", requestId: "request-1", sender, target, message: "核查👩🏽‍💻\n接口",
  status: "awaiting_cost_approval", acceptedAt: 1000, updatedAt: 1000,
  costReview: { capturedAt: 1000, model: "model-a", cacheHeat: "cold", targetStatus: "idle",
    context: { used: 50000, max: 100000, kind: "current_context", capacityKnown: true, reference: false, modelMismatch: false } },
});
let node: HTMLDivElement;
let root: Root;
const button = (key: string) => [...node.querySelectorAll("button")].find((b) => b.textContent === i18n.t(`crossSession.${key}`))!;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  chat.sessions = []; chat.bySession = {}; chat.openTabs = [];
  actions.approve.mockResolvedValue(undefined);
  actions.cancel.mockResolvedValue(undefined);
  native.invoke.mockImplementation(async command => command === "host_confirmation_open" ? true : { leaders: [], branches: [] });
  native.refresh.mockResolvedValue(undefined);
  useCrossSessionActivityStore.getState().reset();
  await i18n.changeLanguage("en");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });

describe("cost approval", () => {
  it.each([false, true])("prepares and hands the original child to a successor only after confirmation (explicit target: %s)", async explicitTarget => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const source = { engine: "agy", sessionId: `auto-summary-child-${explicitTarget}`, workspacePath: "/auto-summary" };
      const held = { ...record(), scopedId: `leader:auto-summary-${explicitTarget}`, target: source, message: "原样保留的新任务🙂".repeat(200),
        leaderCostApproval: { branchId: "auto-summary", requestId: `auto-held-${explicitTarget}`, model: "gemini-4-argon" } };
      chat.sessions = [{ ...source, filePath: "/synthetic-history", fileSize: 100, fileMtimeMs: 1, updatedAt: 1 } as SessionMeta];
      useCrossSessionActivityStore.getState().upsertRecord(held);
      const summary = "自动摘要：已核对原子会话约束，接班后继续原任务并回传主会话。";
      native.invoke.mockImplementation(async (command: string, args?: { selection?: unknown }) => ["task_managed_child_handoff_selection_supported", "host_confirmation_open"].includes(command) ? true
        : command === "task_resolve_handoff_selection" ? args?.selection : command === "load_session_page"
        ? { messages: [{ seq: 1, role: "assistant", text: "旧子会话的已确认约束与待办。" }], nextBefore: null }
        : command === "handoff_full_history_supported" ? true : command === "summarize_session_handoff" ? summary : { leaders: [], branches: [] });
      await act(async () => root.render(<CrossSessionCostApproval record={held} />));
      await act(async () => button("managedHandoffOpen").click());
      expect(native.invoke.mock.calls.filter(([name]) => name === "summarize_session_handoff")).toHaveLength(0);
      await vi.waitFor(() => expect(button("managedHandoffGenerate")?.disabled).toBe(false));
      await act(async () => button("managedHandoffGenerate").click());
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(node.querySelector("textarea")?.value).toBe(summary);
      });
      expect(native.invoke.mock.calls.filter(([name]) => name === "summarize_session_handoff")).toHaveLength(1);
      const summaryArgs = native.invoke.mock.calls.find(([name]) => name === "summarize_session_handoff")![1];
      expect(summaryArgs).toMatchObject({ engine: source.engine, sessionId: source.sessionId, historyScope: "full" });
      expect(summaryArgs).not.toHaveProperty("transcriptExcerpt");
      expect(native.invoke.mock.calls.filter(([name]) => name === "task_handoff_child")).toHaveLength(0);
      expect(node.querySelector("pre")?.textContent).toBe(held.message);
      if (explicitTarget) await act(async () => (node.querySelector('[data-testid="target-picker"]') as HTMLButtonElement).click());
      expect(node.querySelector("textarea")?.value).toBe(summary);
      await act(async () => button("managedHandoffSubmit").click());
      const handoffs = native.invoke.mock.calls.filter(([name]) => name === "task_handoff_child");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0][1]).toMatchObject({ parentEngine: sender.engine, parentSessionId: sender.sessionId,
        workspacePath: sender.workspacePath, branchId: "auto-summary", requestId: `auto-held-${explicitTarget}`, sourceSessionId: source.sessionId,
        reviewedModel: "gemini-4-argon", summary });
      if (explicitTarget) expect(handoffs[0][1]).toHaveProperty("targetSelection", { engine: "codex", model: "gpt-6-astra", providerId: "__local__", effort: "high" });
      else expect(handoffs[0][1]).not.toHaveProperty("targetSelection");
      expect(actions.approve).not.toHaveBeenCalled(); expect(actions.cancel).not.toHaveBeenCalled();
      expect(native.invoke.mock.calls.some(([name]) => name === "start_new_chat" || name === "send_message")).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["G:/project", ""])("preserves each approval card's ownership policy for metadata path %s", async workspacePath => {
    const active = { ...target, engine: "codex", workspacePath: "G:\\project", model: "gpt-6-astra" };
    const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
    const meta = { ...active, workspacePath, model: "old-model" } as SessionMeta;
    chat.sessions = [meta]; chat.openTabs = [active];
    chat.bySession[key] = { ...EMPTY_SESSION, usage: { input_tokens: 50_000 },
      messages: [{ model: "old-model", usage: { input_tokens: 50_000 } }] as never };
    const held = { ...record(), target: active };
    await act(async () => root.render(<CrossSessionCostApproval record={held} />));
    if (workspacePath) {
      expect(node.textContent).toContain("gpt-6-astra");
      expect(node.textContent).toContain(i18n.t("crossSession.costModelChanged", { model: "old-model" }));
    } else {
      expect(node.textContent).not.toContain("gpt-6-astra");
      expect(node.textContent).toContain("model-a");
    }
    useSessionSendCostGuardStore.getState().hold({ sessionKey: key, engine: active.engine,
      sessionId: active.sessionId, workspacePath: active.workspacePath, prompt: "continue", images: [], mode: "send", review: held.costReview! });
    await act(async () => root.render(<SessionSendCostApproval active={active} />));
    expect(node.textContent).toContain("gpt-6-astra");
    expect(node.textContent).toContain(i18n.t("crossSession.costModelChanged", { model: "old-model" }));
    expect(meta.workspacePath).toBe(workspacePath);
  });
  it("prepares a handoff for the held target without approving or cancelling the original request", async () => {
    const held = record();
    useCrossSessionActivityStore.getState().upsertRecord(held);
    useHandoffStore.setState({ byWorkspace: {} });
    const prepare = vi.spyOn(useHandoffStore.getState(), "startHandoff").mockImplementation(() => {});
    await act(async () => root.render(<CrossSessionCostApproval record={held} />));
    await act(async () => button("costHandoff").click());
    expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workspacePath: target.workspacePath, sourceEngine: target.engine, sourceSessionId: target.sessionId,
      nextTask: held.message, archiveSourceOnSend: false, initialMode: "local",
    }));
    expect(actions.approve).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
    expect(useCrossSessionActivityStore.getState().records[0].status).toBe("awaiting_cost_approval");
  });
  it("offers managed child Handoff for advisory cache and submits only after explicit confirmation", async () => {
    const held = { ...record(), kind: "subtask" as const, target: { ...target, engine: "agy" },
      leaderCostApproval: { branchId: "branch-1", requestId: "held-1", model: "gemini-4-argon" } };
    held.costReview!.cacheHeat = "unknown";
    held.costReview!.cache = { startedAt: 1000, observedAt: 1000, ttlSeconds: 900, source: "agy-vertex-reference",
      reference: { maxTtlSeconds: 1200, cacheReadTokens: 0, promptTokens: 353093 } };
    useCrossSessionActivityStore.getState().upsertRecord(held);
    useHandoffStore.setState({ byWorkspace: {} });
    const prepare = vi.spyOn(useHandoffStore.getState(), "startHandoff").mockImplementation(() => {});
    await act(async () => root.render(<CrossSessionCostApproval record={held} />));
    expect(node.textContent).toContain(i18n.t("crossSession.costCacheUnknown"));
    expect(button("managedHandoffOpen")).toBeDefined();
    await act(async () => button("managedHandoffOpen").click());
    expect(node.querySelector('[aria-label="' + i18n.t("crossSession.managedHandoffTitle") + '"]')).not.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(actions.approve).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("task_managed_child_handoff_selection_supported");
    expect(useCrossSessionActivityStore.getState().records[0].status).toBe("awaiting_cost_approval");
    const textarea = node.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "交接摘要🙂"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("managedHandoffSubmit").click());
    expect(native.invoke.mock.calls.filter(([name]) => name === "task_handoff_child")).toEqual([["task_handoff_child", expect.objectContaining({
      parentEngine: sender.engine, parentSessionId: sender.sessionId, branchId: "branch-1", requestId: "held-1",
      sourceSessionId: target.sessionId, reviewedModel: "gemini-4-argon", summary: "交接摘要🙂", operationId: expect.any(String),
    })]]);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each(["consultation", "subtask"] as const)("keeps legacy unloaded Codex %s approval manual without cache expiry claims", async (kind) => {
    const value = { ...record(), target: { ...target, engine: "codex" }, kind,
      leaderCostApproval: kind === "subtask" ? { branchId: "branch-1", requestId: "held-1", model: "gpt-6-astra" } : undefined };
    value.costReview = { ...value.costReview!, model: kind === "subtask" ? "old-model" : "gpt-6-astra", targetStatus: "busy",
      cache: { startedAt: 1000, observedAt: 1000, ttlSeconds: 300, source: "anthropic-usage" } };
    expect(value.costReview.cacheExpiryDisabled).toBeUndefined();
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(button("costApprove")).toBeDefined();
    expect(button("costCancel")).toBeDefined();
    for (const key of ["costCacheCold", "costCacheUnknown", "costCacheHot", "costQueueWarning"]) {
      expect(node.textContent).not.toContain(i18n.t(`crossSession.${key}`));
    }
    if (kind === "consultation") expect(node.textContent).toContain(i18n.t("crossSession.costQueuePending"));
    expect(actions.approve).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each(["send", "queue_drain"] as const)("retains Codex model-change confirmation in %s mode without expiry wording", async (mode) => {
    const active = { ...target, engine: "codex" } as ActiveSession;
    const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
    const onApproveSend = vi.fn();
    const review = { ...record().costReview!, model: "gpt-6-astra",
      cache: { startedAt: 1000, observedAt: 1000, ttlSeconds: 300, source: "anthropic-usage" as const },
      context: { ...record().costReview!.context, modelMismatch: true, usageModel: "gpt-4.1" } };
    useSessionSendCostGuardStore.getState().hold({ sessionKey: key, engine: active.engine,
      sessionId: active.sessionId!, workspacePath: active.workspacePath, prompt: "Continue", images: [], mode, review, onApproveSend });
    await act(async () => root.render(<SessionSendCostApproval active={active} />));
    expect(node.querySelector('[data-testid="session-send-cost-approval"]')).not.toBeNull();
    expect(node.textContent).toContain(i18n.t(mode === "send" ? "crossSession.selfCostModelApprovalPending" : "crossSession.selfCostModelQueuePending"));
    expect(node.textContent).toContain(i18n.t("crossSession.costModelChanged", { model: "gpt-4.1" }));
    for (const key of ["costCacheCold", "costCacheUnknown", "costCacheHot", "selfCostApprovalPending", "selfCostQueuePending"]) {
      expect(node.textContent).not.toContain(i18n.t(`crossSession.${key}`));
    }
    expect(onApproveSend).not.toHaveBeenCalled();
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="session-cost-send-btn"]')!.click());
    expect(onApproveSend).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("resolves native held task approve=%s with its exact identity and model", async (approve) => {
    const value = { ...record(), kind: "subtask" as const,
      leaderCostApproval: { branchId: "branch-1", requestId: "held-1", model: "native-model" } };
    value.costReview!.model = "native-model";
    chat.sessions = [{ ...target, model: "tab-model" } as SessionMeta];
    chat.openTabs = [{ ...target, model: "tab-model" } as ActiveSession];
    chat.bySession[sessionKey(target.engine, target.sessionId, target.workspacePath)] = {
      ...EMPTY_SESSION, activeModel: "tab-model", messages: [], usage: { input_tokens: 1200, model_context_window: 123456 },
    };
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(node.textContent).toContain("native-model");
    expect(node.textContent).not.toContain("tab-model");
    expect(node.textContent).not.toContain("123,456");
    expect(node.textContent).toContain(i18n.t("crossSession.costLastRequest", { used: "1,200" }));
    expect(node.textContent).not.toContain(i18n.t("crossSession.costReference"));
    expect(node.textContent).not.toContain(i18n.t("crossSession.costQueueWarning"));
    expect(native.invoke).not.toHaveBeenCalled();
    await act(async () => button(approve ? "costApprove" : "costCancel").click());
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("task_resolve_cost_approval", {
      parentEngine: sender.engine, parentSessionId: sender.sessionId, workspacePath: sender.workspacePath,
      branchId: "branch-1", requestId: "held-1", approve, reviewedModel: "native-model",
    });
    expect(native.refresh).toHaveBeenCalledTimes(1);
    expect(actions.approve).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
  });

  it("locks native approval, exposes errors, and retains the original request on retry", async () => {
    let reject!: (cause: Error) => void;
    native.invoke.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const value = { ...record(), kind: "subtask" as const,
      leaderCostApproval: { branchId: "branch-1", requestId: "held-old", model: null } };
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    await act(async () => { button("costApprove").click(); button("costApprove").click(); });
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(button("costCancel").disabled).toBe(true);
    await act(async () => reject(new Error("stale native request")));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("stale native request");
    await act(async () => button("costCancel").click());
    expect(native.invoke).toHaveBeenLastCalledWith("task_resolve_cost_approval",
      expect.objectContaining({ requestId: "held-old", reviewedModel: null, approve: false }));
    expect(actions.cancel).not.toHaveBeenCalled();
  });

  it("labels loaded task usage from another model as a last-request sample", async () => {
    const value = { ...record(), kind: "subtask" as const,
      leaderCostApproval: { branchId: "branch-1", requestId: "held-1", model: "claude-opus-4-5" } };
    value.costReview!.model = "claude-opus-4-5";
    chat.sessions = [{ ...target, model: "claude-sonnet-4-5" } as SessionMeta];
    chat.bySession[sessionKey(target.engine, target.sessionId, target.workspacePath)] = {
      ...EMPTY_SESSION, activeModel: "claude-sonnet-4-5", usage: { input_tokens: 1200 },
      messages: [{ seq: 1, role: "assistant", text: "", ts: null, model: "claude-sonnet-4-5", usage: { input_tokens: 1200 } }],
    };
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(node.textContent).toContain(i18n.t("crossSession.costModelChanged", { model: "claude-sonnet-4-5" }));
    expect(node.textContent).toContain(i18n.t("crossSession.costLastRequest", { used: "1,200" }));
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("refreshes a loaded target's model and usage instead of retaining the original snapshot", async () => {
    chat.sessions = [{ ...target, model: "claude-sonnet-4-5" } as SessionMeta];
    const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
    chat.bySession[key] = { ...EMPTY_SESSION, messages: [], usage: { input_tokens: 1200 }, activeModel: "claude-sonnet-4-5" };
    const value = record();
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(node.textContent).toContain("1,200");
    expect(node.textContent).not.toContain("50,000");
    chat.bySession[key] = { ...chat.bySession[key], usage: { input_tokens: 2400 }, activeModel: "claude-opus-4-5" };
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(node.textContent).toContain("2,400");
    expect(node.textContent).toContain("claude-opus-4-5");
    expect(actions.approve).not.toHaveBeenCalled();
  });

  it("keeps the original review when an identically keyed tab belongs to another workspace", async () => {
    const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
    chat.sessions = [{ ...target, model: "model-a" } as SessionMeta];
    chat.openTabs = [{ ...target, workspacePath: "/different" } as ActiveSession];
    chat.bySession[key] = { ...EMPTY_SESSION, usage: { input_tokens: 75000 },
      messages: [{ seq: 1, role: "assistant", text: "", ts: null, model: "model-a", usage: { input_tokens: 75000 } }] };
    const held = record();
    await act(async () => root.render(<CrossSessionCostApproval record={held} />));
    expect(node.textContent).toContain("50,000");
    expect(node.textContent).not.toContain("75,000");
    useSessionSendCostGuardStore.getState().hold({ sessionKey: key, engine: target.engine, sessionId: target.sessionId,
      workspacePath: target.workspacePath, prompt: "resume", images: [], mode: "send", review: held.costReview! });
    await act(async () => root.render(<SessionSendCostApproval active={target as ActiveSession} />));
    expect(node.textContent).toContain("50,000");
    expect(node.textContent).not.toContain("75,000");
    expect(useSessionSendCostGuardStore.getState().bySessionKey[key]).toBeDefined();
    await act(async () => useSessionSendCostGuardStore.getState().dismiss(key));
  });

  it("shows the captured window and never approves on mount", async () => {
    await act(async () => root.render(<CrossSessionCostApproval record={record()} />));
    expect(actions.approve).not.toHaveBeenCalled();
    expect(node.textContent).toContain(i18n.t("crossSession.costContext", { used: "50,000", max: "100,000", pct: 50 }));
    expect(node.textContent).toContain(i18n.t("crossSession.costCacheCold"));
    expect(node.textContent).toContain(i18n.t("crossSession.costSampledAt", { time: new Date(1000).toLocaleString() }));
    await act(async () => button("costApprove").click());
    expect(actions.approve).toHaveBeenCalledExactlyOnceWith("approval-1", undefined, "model-a");
    expect(actions.cancel).not.toHaveBeenCalled();
  });
  it("updates cache expiry while the human is reading without approving or changing the usage sample", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const value = record();
    value.costReview!.cacheHeat = "hot";
    value.costReview!.cache = { startedAt: now - 290000, observedAt: now - 290000, ttlSeconds: 300, source: "anthropic-usage" };
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(node.textContent).toContain(i18n.t("crossSession.costCacheHot"));
    await act(async () => vi.advanceTimersByTimeAsync(10001));
    expect(node.textContent).toContain(i18n.t("crossSession.costCacheCold"));
    expect(node.textContent).toContain("50,000");
    expect(actions.approve).not.toHaveBeenCalled();
  });

  it.each(["unknown", "last_request", "mismatch"] as const)("keeps %s usage separate from measured current occupancy", async (kind) => {
    const value = record();
    value.costReview!.targetStatus = "busy";
    value.costReview!.context = {
      used: kind === "unknown" ? undefined : 50000, max: 200000, capacityKnown: kind !== "unknown",
      kind: kind === "last_request" ? "last_request" : "current_context", reference: true,
      modelMismatch: kind === "mismatch", usageModel: "old-model",
    };
    await act(async () => root.render(<CrossSessionCostApproval record={value} />));
    expect(node.textContent).not.toContain("25%");
    expect(node.textContent).toContain(i18n.t("crossSession.costQueueWarning"));
    if (kind === "unknown") {
      expect(node.textContent).toContain(i18n.t("crossSession.costContextUnknown"));
      expect(node.textContent).not.toContain("200,000");
    } else {
      expect(node.textContent).toContain(i18n.t("crossSession.costLastRequest", { used: "50,000" }));
    }
    if (kind === "mismatch") expect(node.textContent).toContain(i18n.t("crossSession.costModelChanged", { model: "old-model" }));
  });

  it("locks both actions during submission, reports errors inline and allows cancellation", async () => {
    let reject!: (error: Error) => void;
    actions.approve.mockReturnValueOnce(new Promise<void>((_, fail) => { reject = fail; }));
    await act(async () => root.render(<CrossSessionCostApproval record={record()} />));
    await act(async () => { button("costApprove").click(); button("costApprove").click(); });
    expect(actions.approve).toHaveBeenCalledTimes(1);
    expect(button("costApprove").disabled).toBe(true);
    expect(button("costCancel").disabled).toBe(true);
    await act(async () => reject(new Error("approval failed")));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("approval failed");
    expect(button("costCancel").disabled).toBe(false);
    await act(async () => button("costCancel").click());
    expect(actions.cancel).toHaveBeenCalledExactlyOnceWith("approval-1");
  });

  it.each(["consultation", "subtask"] as const)("shows %s approval to both exact participants and retains the normal target queue", async (kind) => {
    useCrossSessionActivityStore.getState().upsertRecord({ ...record(), kind,
      leaderCostApproval: kind === "subtask" ? { branchId: "branch-1", requestId: "held-1", model: "model-a" } : undefined });
    useCrossSessionActivityStore.getState().upsertRecord({ ...record(), scopedId: "queued-1", status: "queued", message: "already queued" });
    const render = (active: typeof sender | typeof target) => act(async () => root.render(<CrossSessionQueue active={active as ActiveSession} />));
    await render(sender);
    expect(node.querySelectorAll('[data-testid="cross-session-approval-queue"]')).toHaveLength(1);
    expect(node.textContent).toContain("Sender → Target");
    expect(node.textContent).toContain(record().message);
    expect(node.textContent).not.toContain("already queued");
    await render(target);
    expect(node.querySelectorAll('[data-testid="cross-session-approval-queue"]')).toHaveLength(1);
    expect(node.textContent).toContain("already queued");
    for (const wrong of [{ ...target, engine: "codex" }, { ...target, workspacePath: "/other" }, { ...target, sessionId: "other" }]) {
      await render(wrong);
      expect(node.querySelector('[data-testid="cross-session-approval-queue"]')).toBeNull();
    }
    expect(actions.approve).not.toHaveBeenCalled();
  });

  it("supports daily session send cost confirmation with handoff, direct send, and cancel", async () => {
    const startHandoff = vi.spyOn(useHandoffStore.getState(), "startHandoff").mockImplementation(() => {});
    const onApproveSend = vi.fn();
    const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
    useSessionSendCostGuardStore.getState().hold({
      sessionKey: key,
      engine: target.engine,
      sessionId: target.sessionId,
      workspacePath: target.workspacePath,
      prompt: "继续完成修改",
      images: [],
      mode: "send",
      review: record().costReview!,
      onApproveSend,
    });
    await act(async () => root.render(<SessionSendCostApproval active={target as ActiveSession} />));
    expect(node.querySelector('[data-testid="session-send-cost-approval"]')).not.toBeNull();
    expect(node.textContent).toContain("50,000");

    // Click Handoff: carries prompt as nextTask and clears draft
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="session-cost-handoff-btn"]')!.click());
    expect(chat.setDraft).toHaveBeenCalledWith(key, "");
    expect(startHandoff).toHaveBeenCalledWith(expect.objectContaining({
      sourceEngine: target.engine,
      sourceSessionId: target.sessionId,
      nextTask: "继续完成修改",
    }));
    expect(node.querySelector('[data-testid="session-send-cost-approval"]')).toBeNull();

    // Hold again and click Send directly anyway
    await act(async () => {
      useSessionSendCostGuardStore.getState().hold({
        sessionKey: key,
        engine: target.engine,
        sessionId: target.sessionId,
        workspacePath: target.workspacePath,
        prompt: "直接发出去",
        images: [],
        mode: "send",
        review: record().costReview!,
        onApproveSend,
      });
    });
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="session-cost-send-btn"]')!.click());
    expect(onApproveSend).toHaveBeenCalledTimes(1);
    expect(useSessionSendCostGuardStore.getState().isApproved(key, record().costReview!)).toBe(true);
    startHandoff.mockRestore();
  });
});
