import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecentThreadList, RepoItem } from "./repo-tree";
import { recentThreadsByActivity } from "./recent-threads";
import { useLeaderTreeUI } from "@/features/leader/tree-ui";
import type { AiChatThread } from "./sidebar-types";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useLeaderTreeUI.setState({ expanded: new Set() });
  useCrossSessionActivityStore.getState().reset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
const tree: AiChatThread = { id: "parent", label: "parent", time: "", children: [
  { id: "child", label: "child", time: "", children: [{ id: "grandchild", label: "grandchild", time: "" }] },
] };
const label = (value: string) => node.querySelector(`[title="${value}"]`);

it("keeps children collapsed until disclosure, with selection and context menu intact", async () => {
  const select = vi.fn();
  const context = vi.fn();
  await act(async () => root.render(<RecentThreadList threads={[tree]} onThreadSelect={select} onThreadContextMenu={context} />));
  expect(label("child")).toBeNull();
  const toggle = node.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(toggle).not.toBeNull();
  expect(toggle.classList.contains("-ml-5")).toBe(false);
  await act(async () => toggle.click());
  expect(label("child")).not.toBeNull();
  expect(label("grandchild")).toBeNull();
  await act(async () => label("child")!.closest("button")!.click());
  expect(select).toHaveBeenCalledWith("child");
  label("child")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  expect(context).toHaveBeenCalledWith(expect.anything(), "child");
});

it("paginates roots and reveals an off-page selected grandchild with all ancestors", async () => {
  const threads = [{ id: "first", label: "first", time: "" }, tree];
  await act(async () => root.render(<RecentThreadList threads={threads} threadLimit={1} />));
  expect(label("parent")).toBeNull();
  await act(async () => root.render(<RecentThreadList threads={threads} threadLimit={1} activeThreadId="grandchild" />));
  expect(label("parent")).not.toBeNull();
  expect(label("grandchild")?.closest("button")?.getAttribute("aria-current")).toBe("page");
  expect([...node.querySelectorAll("button[aria-expanded]")].map((el) => el.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
});

it("retains disclosure state when switching between workspace and all-session views", async () => {
  const repo = { id: "workspace", label: "workspace", threads: [tree] };
  await act(async () => root.render(<RepoItem repo={repo} open />));
  await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="leader.toggleChildren"]')!.click());
  expect(label("child")).not.toBeNull();
  await act(async () => root.render(<RecentThreadList threads={recentThreadsByActivity([repo])} />));
  expect(label("child")).not.toBeNull();
  expect(node.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => root.render(<RepoItem repo={repo} open />));
  expect(label("child")).not.toBeNull();
});

it("shows the workspace label only on the root in all-session trees and formats structured titles", async () => {
  const structuredTree: AiChatThread = {
    ...tree,
    label: "🧩 对话 Git 分支 | 排查无法显示",
  };
  const threads = recentThreadsByActivity([{ id: "ws", label: "ccgui-custom", threads: [structuredTree] }]);
  await act(async () => root.render(<RecentThreadList threads={threads} activeThreadId="grandchild" />));
  expect(label("child")).not.toBeNull();
  expect(label("grandchild")).not.toBeNull();
  const rootTitle = label("🧩 对话 Git 分支 | 排查无法显示");
  expect(rootTitle).not.toBeNull();
  const spans = rootTitle!.querySelectorAll("span");
  expect(spans[0]?.textContent).toBe("🧩 对话 Git 分支");
  expect(spans[2]?.textContent).toBe("排查无法显示");
  const labels = node.querySelectorAll('[title="ccgui-custom"]');
  expect(labels).toHaveLength(1);
  expect(labels[0].className).toContain("max-w-28");
  expect(labels[0].parentElement).toBe(rootTitle!.closest("button")!.parentElement);
  expect(threads[0].children?.[0].children?.[0].workspaceLabel).toBe("ccgui-custom");
});

it.each(["workspace", "recent"])("keeps communication actions separate from selection in the %s list", async (mode) => {
  const select = vi.fn();
  const sender = { engine: "codex", sessionId: "sender", workspacePath: "/ws", title: "sender" };
  const target = { engine: "claude", sessionId: "target", workspacePath: "/ws", title: "target" };
  const threads: AiChatThread[] = [
    { id: "codex/sender", label: "sender", workspacePath: "/ws", time: "1m", children: [
      { id: "claude/target", label: "target", workspacePath: "/ws", time: "2m" },
      { id: "codex/sender", label: "other workspace", workspacePath: "/other", time: "3m" },
    ] },
  ];
  const repo = { id: "workspace", label: "workspace", threads };
  await act(async () => root.render(mode === "recent"
    ? <RecentThreadList threads={recentThreadsByActivity([repo])} onThreadSelect={select} activeThreadId="claude/target" />
    : <RepoItem repo={repo} open onThreadSelect={select} activeThreadId="claude/target" />));
  expect(node.querySelector('[data-testid="thread-cross-session-btn"]')).toBeNull();
  await act(async () => useCrossSessionActivityStore.getState().upsertRecord({
    scopedId: "comm-1", requestId: "comm-1", sender, target,
    message: "Please inspect", status: "executing", acceptedAt: 1, updatedAt: 2,
  }));
  expect(node.querySelectorAll('[data-testid="thread-cross-session-btn"]')).toHaveLength(2);
  const senderRow = label("sender")!.closest("button")!.parentElement!;
  const targetRow = label("target")!.closest("button")!.parentElement!;
  const otherRow = label("other workspace")!.closest("button")!.parentElement!;
  expect(senderRow.getAttribute("data-comm-active")).toBe("true");
  expect(targetRow.getAttribute("data-comm-active")).toBe("true");
  expect(senderRow.querySelector('[data-testid="thread-cross-session-summary"]')?.textContent).toBe("crossSession.rowAsking");
  expect(targetRow.querySelector('[data-testid="thread-cross-session-summary"]')?.textContent).toBe("crossSession.rowReplying");
  const senderMarker = senderRow.querySelector<HTMLButtonElement>('[data-testid="thread-cross-session-btn"]')!;
  await act(async () => senderMarker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(targetRow.getAttribute("data-comm-related")).toBe("true");
  expect(otherRow.hasAttribute("data-comm-related")).toBe(false);
  expect(senderRow.hasAttribute("data-comm-related")).toBe(false);
  await act(async () => senderMarker.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(targetRow.hasAttribute("data-comm-related")).toBe(false);
  await act(async () => senderMarker.focus());
  expect(targetRow.getAttribute("data-comm-related")).toBe("true");
  expect(label("other workspace")!.closest("button")!.parentElement!.querySelector('[data-testid="thread-cross-session-btn"]')).toBeNull();
  expect(document.querySelector('[data-testid="cross-session-details"]')).toBeNull();
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="thread-cross-session-btn"]')!.click());
  expect(select).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="cross-session-details"]')).not.toBeNull();
  await act(async () => useCrossSessionActivityStore.getState().upsertRecord({
    ...useCrossSessionActivityStore.getState().records[0], status: "completed", replyText: "Done",
  }));
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="crossSession.closePanel"]')!.click());
  expect(label("sender")!.closest("button")!.parentElement!.querySelector('[data-testid="thread-cross-session-btn"]')).toBeNull();
  expect(senderRow.hasAttribute("data-comm-active")).toBe(false);
  expect(targetRow.hasAttribute("data-comm-related")).toBe(false);
  expect(senderRow.querySelector('[data-testid="thread-cross-session-summary"]')).toBeNull();
  expect(senderRow.textContent).toContain("1m");
  expect(document.activeElement).toBe(label("sender")!.closest("button"));
  await act(async () => label("sender")!.closest("button")!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith("codex/sender");
});
