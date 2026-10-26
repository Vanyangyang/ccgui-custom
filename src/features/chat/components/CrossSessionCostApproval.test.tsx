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

const actions = vi.hoisted(() => ({ approve: vi.fn(), cancel: vi.fn(), send: vi.fn() }));
const native = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/transport", () => ({ invoke: native.invoke, isWeb: false, listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/leader/store", () => ({ useLeaderStore: { getState: () => ({ refresh: native.refresh }) } }));
vi.mock("../cross-session", async (original) => ({
  ...await original<typeof import("../cross-session")>(),
  approveCrossSessionMessage: actions.approve,
  cancelCrossSessionMessage: actions.cancel,
  sendCrossSessionMessageNow: actions.send,
}));
const chat = vi.hoisted(() => ({ sessions: [] as SessionMeta[], setSessionError: vi.fn(), setDraft: vi.fn(), removeQueued: vi.fn(), sendQueuedNow: vi.fn(),
  bySession: {} as ChatStore["bySession"], openTabs: [] as ActiveSession[], models: {} }));
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
  native.invoke.mockResolvedValue({ leaders: [], branches: [] });
  native.refresh.mockResolvedValue(undefined);
  useCrossSessionActivityStore.getState().reset();
  await i18n.changeLanguage("en");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });

describe("cost approval", () => {
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
