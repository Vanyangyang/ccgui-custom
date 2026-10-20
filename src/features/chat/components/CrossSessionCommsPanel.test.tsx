import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CrossSessionCommsToggleButton, CrossSessionThreadIndicator, useCrossSessionThreadActivity } from "./CrossSessionCommsPanel";
import { isCrossSessionRecordUnread, useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "../cross-session";

const chat = vi.hoisted(() => ({ sessions: [], selectSession: vi.fn(async () => {}) }));
vi.mock("../store", () => ({
  useChatStore: Object.assign((selector: (state: typeof chat) => unknown) => selector(chat), { getState: () => chat }),
  sessionKey: (engine: string, id: string, workspace: string) => JSON.stringify([engine, id, workspace]),
}));

const sender = { engine: "codex", sessionId: "sender", workspacePath: "/ws", title: "发送会话" };
const target = { engine: "claude", sessionId: "target", workspacePath: "/ws", title: "接收会话" };
const store = useCrossSessionActivityStore;
const record = (overrides: Partial<CrossSessionCommunicationRecord> = {}): CrossSessionCommunicationRecord => ({
  scopedId: "message-1", requestId: "request-1", sender, target, message: "请核对接口",
  status: "executing", acceptedAt: Date.now() - 1000, updatedAt: Date.now(), ...overrides,
});
let node: HTMLDivElement;
let root: Root;
const details = () => document.querySelector<HTMLElement>('[data-testid="cross-session-details"]');
const indicator = (side: "sender" | "target" = "sender") => node.querySelector<HTMLButtonElement>(`[data-side="${side}"] [data-testid="thread-cross-session-btn"]`);
const click = (button: HTMLElement) => act(async () => button.click());
const renderRows = () => act(async () => root.render(<>
  <div data-side="sender"><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" /></div>
  <div data-side="target"><CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" /></div>
  <button data-testid="outside">Outside</button>
</>));
const close = () => click(details()!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("crossSession.closePanel")}"]`)!);

function ActivitySummary({ side }: { side: "sender" | "target" }) {
  const activity = useCrossSessionThreadActivity(side === "sender" ? "codex/sender" : "claude/target", "/ws");
  return <output data-side={side} data-active={activity.active}>{activity.summary}</output>;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  store.getState().reset();
  chat.selectSession.mockReset().mockResolvedValue(undefined);
  await i18n.changeLanguage("zh");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

describe("cross-session communication details", () => {
  it("prioritizes cost approval and keeps it pending when details close", async () => {
    store.getState().upsertRecord(record({ status: "awaiting_cost_approval" }));
    store.getState().upsertRecord(record({ scopedId: "executing-2" }));
    await act(async () => root.render(<><ActivitySummary side="sender" /><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" /></>));
    expect(node.querySelector("output")?.textContent).toBe(i18n.t("crossSession.rowAwaitingCostApproval", { title: target.title }));
    const trigger = node.querySelector<HTMLButtonElement>('[data-testid="thread-cross-session-btn"]')!;
    expect(trigger.dataset.commStatus).toBe("awaiting_cost_approval");
    await click(trigger);
    expect(details()?.querySelector('[data-testid="cross-session-cost-approval"]')).not.toBeNull();
    await close();
    expect(store.getState().records.find((r) => r.scopedId === "message-1")?.status).toBe("awaiting_cost_approval");
  });

  it.each(["zh", "en"])("describes actual sender and recipient roles in %s and clears terminal summaries", async (language) => {
    await i18n.changeLanguage(language);
    store.getState().upsertRecord(record({ status: "received" }));
    await act(async () => root.render(<><ActivitySummary side="sender" /><ActivitySummary side="target" /></>));
    const summary = (side: string) => node.querySelector(`output[data-side="${side}"]`)!;
    expect(summary("sender").textContent).toBe(i18n.t("crossSession.rowAsking", { title: target.title }));
    expect(summary("target").textContent).toBe(i18n.t("crossSession.rowReceiving", { title: sender.title }));
    expect(summary("sender").textContent).toContain(target.title);
    await act(async () => store.getState().upsertRecord(record()));
    expect(summary("target").textContent).toBe(i18n.t("crossSession.rowReplying", { title: sender.title }));
    await act(async () => store.getState().upsertRecord(record({ status: "awaiting_permission" })));
    expect(summary("target").textContent).toBe(i18n.t("crossSession.rowAwaitingPermission", { title: sender.title }));
    await act(async () => store.getState().upsertRecord(record({ status: "completed" })));
    expect(summary("sender").textContent).toBe("");
    expect(summary("target").getAttribute("data-active")).toBe("false");
  });

  it("shows only exact communicating participants without automatically opening details", async () => {
    await renderRows();
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    await act(async () => store.getState().upsertRecord(record()));
    expect(indicator()).not.toBeNull();
    expect(indicator("target")).not.toBeNull();
    expect(indicator()!.title).toBe(indicator()!.getAttribute("aria-label"));
    expect(details()).toBeNull();
    await act(async () => root.render(<>
      <CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/other" />
      <CrossSessionThreadIndicator threadId="codex/sender" />
      <CrossSessionThreadIndicator threadId="new:codex:/ws" workspacePath="/ws" />
    </>));
    expect(node.querySelector('[data-testid="thread-cross-session-btn"]')).toBeNull();
  });

  it("counts one request once in the manual overview even though both rows have indicators", async () => {
    store.getState().upsertRecord(record());
    await act(async () => root.render(<>
      <CrossSessionCommsToggleButton />
      <CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" />
      <CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" />
    </>));
    expect(node.querySelectorAll('[data-testid="thread-cross-session-btn"]')).toHaveLength(2);
    expect(node.querySelector('[data-testid="cross-session-count"]')?.textContent).toBe("1");
    const overview = node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!;
    expect(overview.title).toBe(overview.getAttribute("aria-label"));
    expect(details()).toBeNull();
    await click(node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!);
    expect(details()).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(1);
  });

  it("allows Escape and outside pointer dismissal during active work", async () => {
    store.getState().upsertRecord(record());
    await renderRows();
    await click(indicator()!);
    expect(details()).not.toBeNull();
    await act(async () => details()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(details()).toBeNull();
    expect(indicator()).not.toBeNull();
    await click(indicator()!);
    expect(details()).not.toBeNull();
    await act(async () => node.querySelector('[data-testid="outside"]')!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(details()).toBeNull();
    expect(indicator()).not.toBeNull();
  });

  it("reviews terminal notifications independently and keeps the open anchor until dismissal", async () => {
    store.getState().upsertRecord(record({ status: "completed", replyText: "已核对" }));
    await renderRows();
    await click(indicator()!);
    expect(details()?.textContent).toContain("已核对");
    expect(indicator()).not.toBeNull();
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(false);
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(true);
    await close();
    expect(indicator()).toBeNull();
    expect(indicator("target")).not.toBeNull();
    await click(indicator("target")!);
    await close();
    expect(indicator("target")).toBeNull();
  });

  it("keeps details open when active work finishes and consumes only the visible participant's result", async () => {
    store.getState().upsertRecord(record());
    await renderRows();
    await click(indicator()!);
    await act(async () => store.getState().upsertRecord(record({ status: "completed", replyText: "最终结果" })));
    expect(details()?.textContent).toContain("最终结果");
    expect(indicator()).not.toBeNull();
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(true);
    await close();
    expect(indicator()).toBeNull();
    expect(indicator("target")).not.toBeNull();
  });

  it("reviews both sides in the overview and clears finished records while retaining active requests", async () => {
    store.getState().upsertRecord(record({ status: "completed" }));
    store.getState().upsertRecord(record({ scopedId: "active-2", status: "queued" }));
    await act(async () => root.render(<CrossSessionCommsToggleButton />));
    await click(node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!);
    const completed = store.getState().records.find((r) => r.scopedId === "message-1")!;
    expect(isCrossSessionRecordUnread(completed, sender)).toBe(false);
    expect(isCrossSessionRecordUnread(completed, target)).toBe(false);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="cross-session-clear-btn"]')!);
    expect(store.getState().records.map((r) => r.scopedId)).toEqual(["active-2"]);
    expect(document.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(1);
    expect(details()).not.toBeNull();
  });

  it("retains long Chinese and emoji text verbatim, including whitespace and markdown", async () => {
    const message = "请核查👩🏽‍💻中文接口\n".repeat(100) + "```ts\nconst x = '✅';\n```";
    const replyText = "完整回复👨‍👩‍👧‍👦\n\n".repeat(100) + "| 中文 | 值 |\n| -- | -- |\n| 结果 | ✅ |";
    store.getState().upsertRecord(record({ message, replyText, status: "completed" }));
    await renderRows();
    await click(indicator()!);
    expect(details()?.textContent).toContain(message);
    expect(details()?.textContent).toContain(replyText);
  });

  it("closes only after successful navigation and shows a recoverable error on failure", async () => {
    store.getState().upsertRecord(record());
    await renderRows();
    await click(indicator()!);
    const targetButton = () => details()!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("crossSession.openTarget", { title: target.title })}"]`)!;
    chat.selectSession.mockRejectedValueOnce(new Error("unavailable"));
    await click(targetButton());
    expect(chat.selectSession).toHaveBeenLastCalledWith(target.engine, target.sessionId, target.workspacePath, undefined);
    expect(details()).not.toBeNull();
    expect(details()?.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("crossSession.openFailed"));
    await click(targetButton());
    expect(chat.selectSession).toHaveBeenCalledTimes(2);
    expect(details()).toBeNull();
  });

  it("renders subtask delegation wording, matches pending leader branches, and disables opening an unbound child", async () => {
    await i18n.changeLanguage("zh");
    const pendingChild = { engine: "agy", sessionId: "leader-branch:branch-pending", workspacePath: "G:\\ws", title: "子对话任务" };
    store.getState().upsertRecord(record({
      scopedId: "leader:branch-pending",
      requestId: "branch-pending",
      kind: "subtask",
      sender: { ...sender, workspacePath: "G:/ws" },
      target: pendingChild,
      message: "请重构 Godot 架构",
      status: "executing",
    }));
    const branchMeta = { id: "branch-pending", engine: "agy", sessionId: null, workspacePath: "G:\\ws", title: "子对话任务" };
    function SubtaskSummary() {
      const parentActivity = useCrossSessionThreadActivity("codex/sender", "G:/ws");
      const childActivity = useCrossSessionThreadActivity("leader-branch:branch-pending", "G:\\ws", branchMeta);
      return <>
        <output data-side="parent">{parentActivity.summary}</output>
        <output data-side="child">{childActivity.summary}</output>
        <div data-side="parent"><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="G:/ws" /></div>
        <div data-side="child"><CrossSessionThreadIndicator threadId="leader-branch:branch-pending" workspacePath="G:\\ws" leaderBranch={branchMeta} /></div>
      </>;
    }
    await act(async () => root.render(<SubtaskSummary />));
    expect(node.querySelector('output[data-side="parent"]')?.textContent).toBe(i18n.t("crossSession.rowDelegating", { title: "子对话任务" }));
    expect(node.querySelector('output[data-side="child"]')?.textContent).toBe(i18n.t("crossSession.rowSubtaskRunning", { title: sender.title }));
    const childBtn = node.querySelector<HTMLButtonElement>('[data-side="child"] [data-testid="thread-cross-session-btn"]')!;
    expect(childBtn).not.toBeNull();
    await click(childBtn);
    expect(details()?.textContent).toContain(`${i18n.t("crossSession.subtaskPromptLabel")}： 请重构 Godot 架构`);
    const targetButton = details()!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("crossSession.openTarget", { title: "子对话任务" })}"]`)!;
    expect(targetButton.disabled).toBe(true);
    await click(targetButton);
    expect(chat.selectSession).not.toHaveBeenCalled();
  });
});
