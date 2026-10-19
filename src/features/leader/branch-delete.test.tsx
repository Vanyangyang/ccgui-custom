import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ThreadContextMenu } from "@/components/application/ai-chat/thread-context-menu";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { invoke } from "@/lib/transport";
import { useLeaderStore } from "./store";
import { LeaderManagementHost } from "./LeaderManagementHost";
import { leaderEventAllowed } from "./event-state";
import type { LeaderBranch, LeaderSnapshot } from "./types";
const runtime = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/transport", () => ({ get isWeb() { return runtime.web; }, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/ipc", () => ({ ipc: { loadSessionPage: vi.fn(async () => ({ messages: [], subagentHistory: [], nextBefore: null })), listPlanReviews: vi.fn(async () => []), computerUseSetActive: vi.fn(async () => {}) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { title?: string; count?: number }) => key === "leader.deleteBranchConfirm" ? `${key}:${options?.title}:${options?.count}` : key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
const parent = { engine: "claude", sessionId: "delete-root", workspacePath: "/delete-test" };
const branch = (id: string, parentSessionId = parent.sessionId, parentEngine = parent.engine): LeaderBranch => ({ id, engine: "codex", sessionId: id, parentSessionId, parentEngine, workspacePath: parent.workspacePath, title: `title-${id}`, task: "", model: null, effort: null, runId: null, state: "completed", createdAt: 1, updatedAt: 1, lastActivityAt: 1, deadlineAt: 1, expired: true, result: "", resultTruncated: false, error: null });
let snapshot: LeaderSnapshot, node: HTMLDivElement, root: Root;
const key = (id: string) => sessionKey("codex", id, parent.workspacePath);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); runtime.web = false;
  snapshot = { leaders: [parent], branches: [branch("delete-child"), branch("delete-grandchild", "delete-child", "codex"), branch("delete-sibling")] };
  useLeaderStore.setState({ snapshot, error: null, busy: false, managing: null, deletingBranch: null });
  useChatStore.setState({ sessions: [], bySession: {}, drafts: {}, openTabs: [], active: null, streamingByKey: {}, retryingByKey: {}, unseen: {}, archivedSessionKeys: {} });
  vi.mocked(invoke).mockImplementation(async (command) => command === "task_delete_branch" ? { ...snapshot, branches: snapshot.branches.map(b => b.id === "delete-sibling" ? b : { ...b, state: "reclaimed" }) } : snapshot);
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
async function renderMenu(id = "delete-child") { await act(async () => root.render(<><ThreadContextMenu menu={{ x: 0, y: 0, threadId: `codex/${id}` }} onClose={() => {}} onThreadAction={vi.fn()} /><LeaderManagementHost /></>)); }
function button(label: string) { return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!; }
it("opens only branch confirmation, cancels without mutation, and confirms the dedicated IPC", async () => {
  await renderMenu(); await act(async () => button("leader.deleteSubtree").click());
  expect(document.body.textContent).toContain("leader.deleteBranchConfirm:title-delete-child:2"); expect(invoke).not.toHaveBeenCalled();
  await act(async () => button("common.cancel").click()); expect(useLeaderStore.getState().deletingBranch).toBeNull(); expect(invoke).not.toHaveBeenCalled();
  await act(async () => button("leader.deleteSubtree").click());
  await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "leader.deleteSubtree")!.click());
  expect(invoke).toHaveBeenCalledWith("task_delete_branch", { parentEngine: "claude", parentSessionId: parent.sessionId, workspacePath: parent.workspacePath, branchId: "delete-child", expectedBranchIds: ["delete-child", "delete-grandchild"] });
  expect(vi.mocked(invoke).mock.calls.every(([cmd]) => ["task_snapshot", "task_delete_branch"].includes(cmd))).toBe(true);
});
it("offers leaf wording and hides unavailable web, archived and reclaimed branches", async () => {
  await renderMenu("delete-sibling"); expect(button("leader.deleteBranch")).toBeTruthy();
  runtime.web = true; await renderMenu(); expect(button("leader.deleteSubtree")).toBeUndefined(); runtime.web = false;
  await act(async () => useLeaderStore.setState({ snapshot: { ...snapshot, archivedGroups: [{ root: parent, title: "group", archivedAt: 1, members: [], branchIds: ["delete-child"] }] } }));
  expect(button("leader.deleteSubtree")).toBeUndefined();
  await act(async () => useLeaderStore.setState({ snapshot: { ...snapshot, branches: snapshot.branches.map(b => ({ ...b, state: "reclaimed" })) } })); expect(button("leader.deleteBranch")).toBeUndefined();
});
it.each([
  ["Renamed conversation", "Automatic conversation title", "Renamed conversation"],
  [null, "Automatic conversation title", "Automatic conversation title"],
])("shows the current conversation title in confirmation (%s)", async (customTitle, title, expected) => {
  useChatStore.setState({ sessions: [{ engine: "codex", sessionId: "delete-child", workspacePath: parent.workspacePath, customTitle, title } as never] });
  await renderMenu(); await act(async () => button("leader.deleteSubtree").click());
  expect(document.body.textContent).toContain(`leader.deleteBranchConfirm:${expected}:2`);
  expect(invoke).not.toHaveBeenCalled();
});
it.each(["running", "waiting", "streaming", "queue", "question", "grant", "plan", "retry"])("blocks active descendant %s", async (activity) => {
  if (["running", "waiting"].includes(activity)) snapshot.branches[1].state = activity as LeaderBranch["state"];
  else useChatStore.setState({ bySession: { [key("delete-grandchild")]: { ...EMPTY_SESSION, streaming: activity === "streaming", queue: activity === "queue" ? [{} as never] : [], messages: activity === "question" ? [{ question: { status: "pending" } } as never] : activity === "grant" ? [{ grant: { status: "pending" } } as never] : activity === "plan" ? [{ planReview: { status: "awaiting_review" } } as never] : [] } }, retryingByKey: activity === "retry" ? { [key("delete-grandchild")]: true } : {} });
  await renderMenu(); expect(button("leader.deleteSubtree").disabled).toBe(true);
  await act(async () => { await expect(useLeaderStore.getState().deleteBranch(parent, "delete-child")).rejects.toThrow(); });
  expect(invoke).not.toHaveBeenCalledWith("task_delete_branch", expect.anything());
});
it("rechecks latest native state before deleting", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...snapshot, branches: snapshot.branches.map(b => ({ ...b, state: "waiting" })) });
  await expect(useLeaderStore.getState().deleteBranch(parent, "delete-child")).rejects.toThrow(); expect(invoke).not.toHaveBeenCalledWith("task_delete_branch", expect.anything());
});
it("disables confirmation when activity starts after opening it", async () => {
  await renderMenu(); await act(async () => button("leader.deleteSubtree").click());
  await act(async () => useChatStore.setState({ streamingByKey: { [key("delete-grandchild")]: true } }));
  const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "leader.deleteSubtree")!;
  expect(confirm.disabled).toBe(true); expect(document.body.textContent).toContain("leader.deleteBranchIdle");
  await act(async () => confirm.click()); expect(invoke).not.toHaveBeenCalled();
});
it("rejects a changed descendant scope instead of enlarging the confirmed deletion", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...snapshot, branches: [...snapshot.branches, branch("new-descendant", "delete-child", "codex")] });
  await expect(useLeaderStore.getState().deleteBranch(parent, "delete-child", ["delete-child", "delete-grandchild"])).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalledWith("task_delete_branch", expect.anything());
  expect(useLeaderStore.getState().snapshot.branches).toHaveLength(4);
});
it("does not offer branch deletion for a remote session", async () => {
  useChatStore.setState({ sessions: [{ engine: "codex", sessionId: "delete-child", workspacePath: parent.workspacePath, remote: true } as never] });
  await renderMenu(); expect(button("leader.deleteSubtree")).toBeUndefined();
});
it("preserves parent and sibling and activates a surviving tab", async () => {
  const members = [parent, ...snapshot.branches.map(b => ({ engine: b.engine, sessionId: b.sessionId!, workspacePath: b.workspacePath }))];
  useChatStore.setState({ openTabs: members, active: members[1], bySession: Object.fromEntries(members.map(m => [sessionKey(m.engine, m.sessionId, m.workspacePath), { ...EMPTY_SESSION }])) });
  await useLeaderStore.getState().deleteBranch(parent, "delete-child");
  expect(useChatStore.getState().openTabs).toEqual([parent, members[3]]); expect(useChatStore.getState().active).toEqual(members[3]);
  expect(useChatStore.getState().bySession[key("delete-grandchild")]).toBeUndefined(); expect(useChatStore.getState().bySession[key("delete-sibling")]).toBeTruthy();
});
it.each([false, true])("reconciles partial failure=%s without retiring surviving sessions", async (partial) => {
  const childId = `failure-child-${partial}`, grandchildId = `failure-grandchild-${partial}`;
  snapshot = { leaders: [parent], branches: [branch(childId), branch(grandchildId, childId, "codex")] };
  useLeaderStore.setState({ snapshot });
  useChatStore.setState({ bySession: { [key(childId)]: { ...EMPTY_SESSION }, [key(grandchildId)]: { ...EMPTY_SESSION } } });
  let attempted = false;
  vi.mocked(invoke).mockImplementation(async command => { if (command === "task_delete_branch") { attempted = true; throw new Error("original delete failure"); } return { ...snapshot, branches: snapshot.branches.map(b => attempted && partial && b.id === grandchildId ? { ...b, state: "reclaimed" } : b) }; });
  await expect(useLeaderStore.getState().deleteBranch(parent, childId)).rejects.toThrow("original delete failure");
  expect(useLeaderStore.getState().error).toBe("original delete failure"); expect(useChatStore.getState().bySession[key(childId)]).toBeTruthy();
  expect(!!useChatStore.getState().bySession[key(grandchildId)]).toBe(!partial);
  expect(leaderEventAllowed(childId, key(childId))).toBe(true);
  expect(leaderEventAllowed(grandchildId, key(grandchildId))).toBe(!partial);
});
