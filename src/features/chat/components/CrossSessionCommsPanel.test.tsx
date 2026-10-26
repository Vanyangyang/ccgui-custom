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
const filter = (id: string) => details()!.querySelector<HTMLButtonElement>(`[data-testid="cross-session-filter-${id}"]`)!;
const overview = () => node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!;
const renderOverview = () => act(async () => root.render(<CrossSessionCommsToggleButton />));

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
  it.each(["retrieved", "deferred", "uncertain"] as const)("retains %s mailbox activity without opening or navigating automatically", async (phase) => {
    await act(async () => root.render(<><ActivitySummary side="target" /><CrossSessionCommsToggleButton /><div data-side="target"><CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" /></div></>));
    const message = "约束 👩🏽‍💻\n```ts\nconst retained = true;\n```";
    const impactReview = "模型报告：已检查现有改动，工具影响仍待确认。";
    await act(async () => store.getState().upsertRecord(record({ status: "unknown", message, replyText: "取回回执", mailbox: { phase, relation: "update", parentRequestId: "parent", kind: "correction", waitReason: "processing_unconfirmed", impactReview } })));
    expect(indicator("target")?.dataset.commStatus).toBe(phase);
    expect(node.querySelector("output")?.textContent).toContain(i18n.t(`crossSession.mailboxPhase.${phase}`));
    expect(details()).toBeNull(); expect(chat.selectSession).not.toHaveBeenCalled();
    await click(overview());
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.textContent).toContain(i18n.t(`crossSession.mailboxPhase.${phase}`));
    expect(details()?.textContent).toContain(i18n.t("crossSession.mailboxWait.processing_unconfirmed"));
    const prompt = details()!.querySelector<HTMLElement>('[data-testid="cross-session-card-prompt"]')!;
    expect(prompt.hidden).toBe(true);
    await click(details()!.querySelector<HTMLElement>('[data-testid="cross-session-card-toggle"]')!);
    expect(prompt.hidden).toBe(false); expect(prompt.textContent).toContain(message);
    expect(details()?.querySelector('[data-testid="cross-session-card-reply"]')?.textContent).toContain("取回回执");
    expect(details()?.querySelector('[data-testid="cross-session-impact-review"]')?.textContent).toContain(impactReview);
    expect(chat.selectSession).not.toHaveBeenCalled();
  });

  it("labels handled mail as a report rather than verified business completion", async () => {
    store.getState().upsertRecord(record({ status: "completed", mailbox: { phase: "handled", relation: "reply", parentRequestId: "parent", kind: "information" } }));
    await renderOverview(); await click(overview());
    expect(details()?.textContent).toContain(i18n.t("crossSession.mailboxPhase.handled"));
    expect(node.querySelector('[data-testid="cross-session-count"]')).toBeNull();
  });

  it.each([
    ["DELEGATION_LEGACY_UNKNOWN", "leader.delegationLegacyUnknown"],
    ["DELEGATION_RESTART_UNKNOWN", "leader.delegationRestartUnknown"],
  ])("localizes the %s assignment outcome without changing the stored evidence", async (code, key) => {
    const error = `${code}: native explanation`;
    store.getState().upsertRecord(record({ kind: "subtask", status: "unknown", error }));
    await renderOverview();
    await click(overview());
    expect(details()?.querySelector('[role="alert"]')?.textContent).toBe(i18n.t(key));
    expect(store.getState().records[0].error).toBe(error);
  });

  it("silently retains successful subtask results in history after active indicators disappear", async () => {
    store.getState().upsertRecord(record({ kind: "subtask" }));
    await act(async () => root.render(<>
      <CrossSessionCommsToggleButton />
      <div data-side="sender"><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" /></div>
      <div data-side="target"><CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" /></div>
    </>));
    expect(indicator()).not.toBeNull();
    expect(indicator("target")).not.toBeNull();
    await click(node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!);
    expect(details()?.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(1);
    await act(async () => store.getState().upsertRecord(record({ kind: "subtask", status: "completed", replyText: "真实子任务结果" })));
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(0);
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    expect(node.querySelector('[data-testid="cross-session-count"]')).toBeNull();
    expect(store.getState().records[0].reviewedBy).toBeUndefined();
    await click(filter("finished"));
    expect(details()?.textContent).toContain("真实子任务结果");
    expect(store.getState().records[0].status).toBe("completed");
    await click(filter("all"));
    expect(details()?.textContent).toContain("真实子任务结果");
    await close();
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
  });

  it.each(["completed", "failed", "unknown"] as const)("retains unread %s history without counting it as sidebar activity", async (status) => {
    store.getState().upsertRecord(record({ kind: "subtask", status }));
    store.getState().upsertRecord(record({ scopedId: "consultation", kind: "consultation", status }));
    await act(async () => root.render(<>
      <CrossSessionCommsToggleButton />
      <div data-side="sender"><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" /></div>
      <div data-side="target"><CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" /></div>
    </>));
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    expect(overview().dataset.commStatus).toBeUndefined();
    expect(node.querySelector('[data-testid="cross-session-count"]')).toBeNull();
    expect(store.getState().records.every((r) => r.reviewedBy === undefined)).toBe(true);
    await click(overview());
    expect(filter("finished").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(2);
    expect(store.getState().records.every((r) => r.status === status)).toBe(true);
  });

  it("counts only live requests when unread history is mixed with activity", async () => {
    for (let i = 0; i < 29; i++) {
      store.getState().upsertRecord(record({ scopedId: `history-${i}`, kind: "subtask", status: "unknown" }));
    }
    const activeStatuses = ["preparing", "queued", "received", "executing", "awaiting_permission", "awaiting_cost_approval"] as const;
    for (const status of activeStatuses) store.getState().upsertRecord(record({ scopedId: status, status }));
    await act(async () => root.render(<>
      <CrossSessionCommsToggleButton />
      <div data-side="sender"><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" /></div>
      <div data-side="target"><CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" /></div>
    </>));
    expect(Array.from(node.querySelectorAll('[data-testid="cross-session-count"]'), (n) => n.textContent)).toEqual(["6", "6", "6"]);
    expect(overview().dataset.commStatus).toBe("awaiting_cost_approval");
    await act(async () => {
      for (const status of activeStatuses) store.getState().upsertRecord(record({ scopedId: status, status: "completed" }));
    });
    expect(node.querySelector('[data-testid="cross-session-count"]')).toBeNull();
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    expect(overview().dataset.commStatus).toBeUndefined();
    expect(store.getState().records.some((r) => r.status === "unknown")).toBe(true);
  });

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

  it("keeps an open anchor until dismissal after completion without showing a terminal activity badge", async () => {
    store.getState().upsertRecord(record());
    await renderRows();
    await click(indicator()!);
    await act(async () => store.getState().upsertRecord(record({ status: "completed", replyText: "已核对" })));
    expect(indicator()).not.toBeNull();
    expect(indicator()!.dataset.commStatus).toBeUndefined();
    expect(indicator("target")).toBeNull();
    await click(filter("finished"));
    expect(filter("finished").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.textContent).toContain("已核对");
    expect(indicator()).not.toBeNull();
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(false);
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(true);
    await close();
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    expect(store.getState().records[0].replyText).toBe("已核对");
  });

  it("removes finished work from active details without reviewing it until explicitly selected", async () => {
    store.getState().upsertRecord(record());
    await renderRows();
    await click(indicator()!);
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    await act(async () => store.getState().upsertRecord(record({ status: "completed", replyText: "最终结果" })));
    expect(details()).not.toBeNull();
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.textContent).not.toContain("最终结果");
    expect(details()?.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(0);
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(true);
    await click(filter("finished"));
    expect(details()?.textContent).toContain("最终结果");
    expect(indicator()).not.toBeNull();
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(false);
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(true);
    await close();
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
  });

  it("reviews both sides in the overview and clears finished records while retaining active requests", async () => {
    store.getState().upsertRecord(record({ status: "completed" }));
    store.getState().upsertRecord(record({ scopedId: "active-2", status: "queued" }));
    await act(async () => root.render(<CrossSessionCommsToggleButton />));
    await click(node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!);
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(1);
    expect(isCrossSessionRecordUnread(store.getState().records.find((r) => r.scopedId === "message-1")!, sender)).toBe(true);
    expect(isCrossSessionRecordUnread(store.getState().records.find((r) => r.scopedId === "message-1")!, target)).toBe(true);
    await click(filter("finished"));
    const completed = store.getState().records.find((r) => r.scopedId === "message-1")!;
    expect(isCrossSessionRecordUnread(completed, sender)).toBe(false);
    expect(isCrossSessionRecordUnread(completed, target)).toBe(false);
    await click(filter("all"));
    await click(document.querySelector<HTMLButtonElement>('[data-testid="cross-session-clear-btn"]')!);
    expect(store.getState().records.map((r) => r.scopedId)).toEqual(["active-2"]);
    expect(document.querySelectorAll('[data-testid="cross-session-comm-card"]')).toHaveLength(1);
    expect(details()).not.toBeNull();
  });

  it("opens an idle overview on finished records and keeps history visible on reopening", async () => {
    store.getState().upsertRecord(record({ status: "completed", replyText: "历史结果" }));
    await act(async () => root.render(<CrossSessionCommsToggleButton />));
    const overview = node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!;
    expect(overview.querySelector('[data-testid="cross-session-count"]')).toBeNull();
    await click(overview);
    expect(filter("finished").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.textContent).toContain("历史结果");
    expect(details()?.querySelector('[data-testid="cross-session-filter-empty"]')).toBeNull();
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(false);
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(false);
    expect(overview.querySelector('[data-testid="cross-session-count"]')).toBeNull();
    await close();
    await click(overview);
    expect(filter("finished").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.textContent).toContain("历史结果");
    await close();
    await act(async () => store.getState().upsertRecord(record({ scopedId: "new-active", status: "queued" })));
    await click(overview);
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.querySelector('[data-testid="cross-session-comm-card"]')?.getAttribute("data-comm-status")).toBe("queued");
  });

  it("reviews unknown subtask history from the overview without changing its outcome", async () => {
    const error = "DELEGATION_LEGACY_UNKNOWN: original assignment outcome unavailable";
    store.getState().upsertRecord(record({ kind: "subtask", status: "unknown", error }));
    await act(async () => root.render(<>
      <CrossSessionCommsToggleButton />
      <div data-side="sender"><CrossSessionThreadIndicator threadId="codex/sender" workspacePath="/ws" /></div>
      <div data-side="target"><CrossSessionThreadIndicator threadId="claude/target" workspacePath="/ws" /></div>
    </>));
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    await click(node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!);
    expect(filter("finished").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("leader.delegationLegacyUnknown"));
    expect(indicator()).toBeNull();
    expect(indicator("target")).toBeNull();
    expect(node.querySelector('[data-testid="cross-session-count"]')).toBeNull();
    expect(store.getState().records[0]).toMatchObject({ status: "unknown", error });
  });

  it("opens mixed participant activity on active and leaves hidden terminal results unread", async () => {
    store.getState().upsertRecord(record({ status: "failed", error: "历史错误" }));
    store.getState().upsertRecord(record({ scopedId: "active-2" }));
    await renderRows();
    await click(indicator()!);
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(details()?.textContent).not.toContain("历史错误");
    expect(isCrossSessionRecordUnread(store.getState().records.find((r) => r.scopedId === "message-1")!, sender)).toBe(true);
    await click(filter("finished"));
    expect(details()?.textContent).toContain("历史错误");
    expect(isCrossSessionRecordUnread(store.getState().records.find((r) => r.scopedId === "message-1")!, sender)).toBe(false);
  });

  it("retains long Chinese and emoji text verbatim, including whitespace and markdown", async () => {
    const message = "请核查👩🏽‍💻中文接口\n".repeat(100) + "```ts\nconst x = '✅';\n```";
    const replyText = "完整回复👨‍👩‍👧‍👦\n\n".repeat(100) + "| 中文 | 值 |\n| -- | -- |\n| 结果 | ✅ |";
    store.getState().upsertRecord(record({ message, replyText, status: "completed" }));
    await renderOverview();
    await click(overview());
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

  it("defaults to compact density, toggles global compact/detailed mode and per-card expansion, and filters by category", async () => {
    const longTask = "请独立审查目标设计文档：\n第1行\n第2行\n第3行\n第4行\n第5行";
    const longReply = "审查结论：\n1. 保留最小闭环\n2. 删除过度设计\n3. 复用协调器结果\n4. 补充测试";
    store.getState().upsertRecord(record({
      scopedId: "leader:subtask-1",
      requestId: "subtask-1",
      kind: "subtask",
      message: longTask,
      replyText: longReply,
      status: "executing",
    }));
    store.getState().upsertRecord(record({
      scopedId: "consult-2",
      requestId: "consult-2",
      kind: "consultation",
      message: "短问题",
      replyText: "短回答",
      status: "completed",
    }));
    await act(async () => root.render(<CrossSessionCommsToggleButton />));
    await click(node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!);

    const panel = details()!;
    expect(panel.dataset.density).toBe("compact");
    const densityBtn = panel.querySelector<HTMLButtonElement>('[data-testid="cross-session-density-btn"]')!;
    expect(densityBtn.getAttribute("aria-pressed")).toBe("false");
    expect(densityBtn.textContent).toBe(i18n.t("crossSession.compactMode"));

    const cards = () => Array.from(panel.querySelectorAll<HTMLElement>('[data-testid="cross-session-comm-card"]'));
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(cards()).toHaveLength(1);
    await click(filter("all"));
    expect(cards()).toHaveLength(2);
    const subtaskCard = () => cards().find((c) => c.textContent?.includes("请独立审查目标设计文档"))!;
    const consultCard = () => cards().find((c) => c.textContent?.includes("短问题"))!;

    // Default compact mode clamps long card and shows per-card expand button, while short card has no toggle button
    expect(subtaskCard().dataset.expanded).toBe("false");
    expect(subtaskCard().querySelector('[data-testid="cross-session-card-prompt"]')?.className).toContain("line-clamp-3");
    expect(subtaskCard().querySelector('[data-testid="cross-session-card-reply"]')?.className).toContain("line-clamp-3");
    expect(consultCard().querySelector('[data-testid="cross-session-card-toggle"]')).toBeNull();

    // Per-card expand / collapse
    const cardToggle = () => subtaskCard().querySelector<HTMLButtonElement>('[data-testid="cross-session-card-toggle"]')!;
    expect(cardToggle().getAttribute("aria-expanded")).toBe("false");
    await click(cardToggle());
    expect(subtaskCard().dataset.expanded).toBe("true");
    expect(subtaskCard().querySelector('[data-testid="cross-session-card-prompt"]')?.className).not.toContain("line-clamp-3");
    expect(cardToggle().getAttribute("aria-expanded")).toBe("true");

    // Global density toggle to detailed expands all cards and resets overrides
    await click(densityBtn);
    expect(panel.dataset.density).toBe("detailed");
    expect(densityBtn.getAttribute("aria-pressed")).toBe("true");
    expect(densityBtn.textContent).toBe(i18n.t("crossSession.detailedMode"));
    expect(subtaskCard().dataset.expanded).toBe("true");
    expect(consultCard().dataset.expanded).toBe("true");

    // In detailed mode, clicking per-card toggle collapses just that card
    await click(cardToggle());
    expect(subtaskCard().dataset.expanded).toBe("false");
    expect(subtaskCard().querySelector('[data-testid="cross-session-card-prompt"]')?.className).toContain("line-clamp-3");

    // Toggling global density back to compact collapses all cards
    await click(densityBtn);
    expect(panel.dataset.density).toBe("compact");
    expect(subtaskCard().dataset.expanded).toBe("false");

    // Category filter buttons
    expect(filter("all").getAttribute("aria-pressed")).toBe("true");
    await click(filter("active"));
    expect(filter("active").getAttribute("aria-pressed")).toBe("true");
    expect(cards()).toHaveLength(1);
    expect(cards()[0].dataset.commStatus).toBe("executing");

    await click(filter("finished"));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].dataset.commStatus).toBe("completed");

    await click(filter("subtask"));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("请独立审查目标设计文档");

    await click(filter("consultation"));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("短问题");

    // Empty category state when finished records are cleared while on "finished" filter
    await click(filter("finished"));
    await click(panel.querySelector<HTMLButtonElement>('[data-testid="cross-session-clear-btn"]')!);
    expect(cards()).toHaveLength(0);
    expect(panel.querySelector('[data-testid="cross-session-filter-empty"]')?.textContent).toBe(i18n.t("crossSession.filterEmpty"));

    await click(filter("all"));
    expect(cards()).toHaveLength(1);
  });
});
