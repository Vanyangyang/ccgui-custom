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
  useCrossSessionActivityStore.getState().reset();
  await i18n.changeLanguage("en");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });

describe("cost approval", () => {
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

  it("shows approval to both exact participants and retains the normal target queue", async () => {
    useCrossSessionActivityStore.getState().upsertRecord(record());
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
