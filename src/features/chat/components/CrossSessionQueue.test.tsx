import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CrossSessionQueue } from "./CrossSessionQueue";
import { useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "../cross-session";
import type { ActiveSession } from "../store";

const actions = vi.hoisted(() => ({ send: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }));
vi.mock("../cross-session", async (original) => ({ ...await original<typeof import("../cross-session")>(), sendCrossSessionMessageNow: actions.send, cancelCrossSessionMessage: actions.cancel }));
const chat = vi.hoisted(() => ({ sessions: [], setSessionError: vi.fn() }));
vi.mock("../store", () => ({
  useChatStore: Object.assign((selector: (state: typeof chat) => unknown) => selector(chat), { getState: () => chat }),
  sessionKey: (engine: string, id: string, workspace: string) => JSON.stringify([engine, id, workspace]),
}));
// The approval component's own tests verify approval actions; this sentinel verifies routing.
vi.mock("./CrossSessionCostApproval", () => ({ CrossSessionCostApproval: () => <div data-testid="approval-card" /> }));
const target = { engine: "claude", sessionId: "target", workspacePath: "/ws" };
const record = (overrides: Partial<CrossSessionCommunicationRecord> = {}): CrossSessionCommunicationRecord => ({
  scopedId: "message", requestId: "request", sender: { ...target, sessionId: "sender", title: "来源会话" }, target,
  message: "完整原文 👩🏽‍💻\n```ts\nconst x = 1;\n```\n".repeat(10), status: "received", acceptedAt: 1, updatedAt: 2,
  mailbox: { phase: "received", relation: "update", parentRequestId: "parent", kind: "correction", waitReason: "target_busy" }, ...overrides,
});
let node: HTMLDivElement;
let root: Root;
const store = useCrossSessionActivityStore;
const render = () => act(async () => root.render(<CrossSessionQueue active={target as ActiveSession} />));
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  store.getState().reset(); vi.clearAllMocks(); await i18n.changeLanguage("zh");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

it("receives related messages quietly and expands verbatim originals with explicit interrupt controls", async () => {
  await render(); expect(node.textContent).toBe("");
  const item = record(); await act(async () => store.getState().upsertRecord(item));
  expect(node.textContent).toContain(i18n.t("crossSession.inboxTitle"));
  expect(node.textContent).toContain("来源会话");
  expect(node.textContent).toContain(i18n.t("crossSession.mailboxKind.correction"));
  expect(node.textContent).toContain(i18n.t("crossSession.mailboxWait.target_busy"));
  const disclosure = node.querySelector("details")!;
  expect(disclosure.open).toBe(false);
  await act(async () => node.querySelector("summary")!.click());
  expect(disclosure.open).toBe(true); expect(disclosure.querySelector("p")!.textContent).toBe(item.message);
  const button = Array.from(node.querySelectorAll("button")).find((b) => b.textContent === i18n.t("crossSession.inboxInterrupt"))!;
  expect(button.title).toBe(i18n.t("crossSession.inboxInterruptTooltip"));
  await act(async () => button.click()); expect(actions.send).toHaveBeenCalledWith("message");
});

it.each(["retrieved", "deferred", "uncertain"] as const)("keeps %s visible without dangerous resend controls", async (phase) => {
  const item = record(); item.mailbox = { ...item.mailbox!, phase, waitReason: "processing_unconfirmed" }; item.status = "unknown";
  store.getState().upsertRecord(item); await render();
  expect(node.textContent).toContain(i18n.t(`crossSession.mailboxPhase.${phase}`));
  expect(node.querySelectorAll("button")).toHaveLength(0);
  expect(actions.send).not.toHaveBeenCalled();
});

it.each(["permission", "cost_approval", "stopped", "target_unavailable"] as const)("explains a held %s message without starting it", async (waitReason) => {
  const item = record(); item.mailbox = { ...item.mailbox!, waitReason }; store.getState().upsertRecord(item); await render();
  expect(node.textContent).toContain(i18n.t(`crossSession.mailboxWait.${waitReason}`));
  expect(node.querySelectorAll("button")).toHaveLength(0);
});

it("preserves the ordinary consultation queue", async () => {
  store.getState().upsertRecord(record({ mailbox: undefined })); await render();
  expect(node.textContent).toContain(i18n.t("crossSession.queueTitle"));
  expect(node.querySelector('[data-testid="cross-session-inbox"]')).toBeNull();
  const button = node.querySelector<HTMLButtonElement>(`button[title="${i18n.t("crossSession.sendNowTooltip")}"]`)!;
  await act(async () => button.click()); expect(actions.send).toHaveBeenCalledWith("message");
});

it("routes cost approval through the existing human card without an interrupt bypass", async () => {
  store.getState().upsertRecord(record({ status: "awaiting_cost_approval" })); await render();
  expect(node.querySelector('[data-testid="approval-card"]')).not.toBeNull();
  expect(node.querySelector('[data-testid="cross-session-inbox"]')).toBeNull();
  expect(node.querySelectorAll("button")).toHaveLength(0); expect(actions.send).not.toHaveBeenCalled();
});
