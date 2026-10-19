import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchivedSessionsSection } from "./ArchivedSessionsSection";
import { useLeaderStore } from "@/features/leader/store";
import { useChatStore } from "@/features/chat/store";
import { invoke, listen } from "@/lib/transport";
import { listenSessionsChanged } from "@/lib/events";
import { ipc, type SessionMeta } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import type { LeaderBranch, LeaderIdentity, LeaderSnapshot } from "@/features/leader/types";

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/transport", () => ({ get isWeb() { return runtime.web; }, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/events", () => ({ listenSessionsChanged: vi.fn(async () => () => {}) }));
vi.mock("@/lib/ipc", () => ({ ipc: {
  listArchivedSessions: vi.fn(), restoreSession: vi.fn(async () => {}), deleteSession: vi.fn(async () => {}),
  deleteRemoteSession: vi.fn(async () => {}), rescanSessions: vi.fn(async () => {}),
} }));

const identity: LeaderIdentity = { engine: "claude", sessionId: "archived-ui-root", workspacePath: "/workspace" };
const child: LeaderBranch = { id: "archived-ui-child", parentEngine: "claude", parentSessionId: identity.sessionId, workspacePath: identity.workspacePath,
  engine: "codex", sessionId: "archived-ui-child", title: "Research child", task: "Research 中文 🚀", model: null, effort: null, runId: null,
  state: "completed", createdAt: 1, updatedAt: 2, lastActivityAt: 2, deadlineAt: 3, expired: false, result: "Child result", resultTruncated: false, error: null };
const grandchild: LeaderBranch = { ...child, id: "archived-ui-grandchild", engine: "claude", sessionId: "archived-ui-grandchild", parentEngine: "codex", parentSessionId: child.sessionId!, title: "Nested child", task: "Nested task", state: "failed", result: "Partial result", error: "Review failed" };
function meta(engine: string, sessionId: string, title: string, workspacePath = "/workspace"): SessionMeta {
  return { engine, sessionId, title, workspacePath, customTitle: null, preview: "", filePath: "", fileSize: 0, fileMtimeMs: 0, createdAt: 1, updatedAt: 2, messageCount: 2, pinned: false };
}
const flatMembers = [meta(identity.engine, identity.sessionId, "Duplicated root"), meta(child.engine, child.sessionId!, "Duplicated child"), meta(grandchild.engine, grandchild.sessionId!, "Duplicated grandchild")];
const ordinary = meta("codex", "ordinary-session", "Ordinary archive");
let snapshot: LeaderSnapshot;
let container: HTMLDivElement, root: Root;
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
async function render() { await act(async () => root.render(<ArchivedSessionsSection />)); }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); localStorage.clear(); await i18n.changeLanguage("en");
  runtime.web = false;
  vi.mocked(listen).mockReset().mockResolvedValue(() => {});
  vi.mocked(listenSessionsChanged).mockReset().mockResolvedValue(() => {});
  snapshot = { leaders: [identity], branches: [child, grandchild], archivedGroups: [{ root: identity, title: "Saved research group", archivedAt: 100,
    members: [identity, { engine: child.engine, sessionId: child.sessionId!, workspacePath: child.workspacePath }, { engine: grandchild.engine, sessionId: grandchild.sessionId!, workspacePath: grandchild.workspacePath }], branchIds: [child.id, grandchild.id] }] };
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, error: null, busy: false, managing: null });
  useChatStore.setState({ workspaces: [{ id: "ws", path: "/workspace", name: "Workspace", lastOpenedAt: null, sortOrder: null, groupId: null }], active: null, openTabs: [], bySession: {}, archivedSessionKeys: {} });
  vi.spyOn(useChatStore.getState(), "refreshSessions").mockResolvedValue();
  vi.mocked(ipc.listArchivedSessions).mockImplementation(async () => [...(snapshot.archivedGroups?.length ? flatMembers : []), ordinary]);
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
    if (command === "task_group_action") snapshot = { ...snapshot, archivedGroups: [] };
    return snapshot;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("archived task groups", () => {
  it("reports a remote Leader snapshot failure and reloads all archive data after reconnect", async () => {
    runtime.web = true;
    let connected!: (event: { payload: unknown }) => void;
    const offConnected = vi.fn(), offSessions = vi.fn();
    vi.mocked(listen).mockImplementation(async (_event, callback) => { connected = callback; return offConnected; });
    vi.mocked(listenSessionsChanged).mockResolvedValueOnce(offSessions);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Leader snapshot denied"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Leader snapshot denied");
    expect(invoke).toHaveBeenCalledWith("task_snapshot", {});
    await act(async () => connected({ payload: "1.1.1" }));
    expect(container.textContent).toContain("Saved research group");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(ipc.listArchivedSessions).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    expect(offConnected).toHaveBeenCalledOnce(); expect(offSessions).toHaveBeenCalledOnce();
    vi.mocked(ipc.listArchivedSessions).mockClear();
    connected({ payload: null });
    expect(ipc.listArchivedSessions).not.toHaveBeenCalled();
  });

  it("removes late archive and connection subscriptions without refreshing after unmount", async () => {
    const pending: Array<(off: () => void) => void> = [];
    let connected!: (event: { payload: unknown }) => void;
    let changed!: () => void;
    vi.mocked(listen).mockImplementation((_event, callback) => { connected = callback; return new Promise((resolve) => pending.push(resolve)); });
    vi.mocked(listenSessionsChanged).mockImplementation((callback) => { changed = callback; return new Promise((resolve) => pending.push(resolve)); });
    await render(); await act(async () => root.unmount());
    const late = pending.map(() => vi.fn());
    await act(async () => pending.forEach((resolve, index) => resolve(late[index])));
    late.forEach((off) => expect(off).toHaveBeenCalledOnce());
    vi.mocked(ipc.listArchivedSessions).mockClear();
    connected({ payload: null }); changed();
    expect(ipc.listArchivedSessions).not.toHaveBeenCalled();
  });
  it.each([false, true])("shows one group alongside ordinary archives, hides duplicate members, and keeps mixed recursive results and relationships (web=%s)", async (web) => {
    runtime.web = web;
    await render();
    expect(container.querySelectorAll("[data-leader-archived-group]")).toHaveLength(1);
    expect(container.textContent).toContain("Saved research group"); expect(container.textContent).toContain("Ordinary archive");
    expect(container.textContent).not.toContain("Duplicated");
    const card = container.querySelector("[data-leader-archived-group]")!;
    const relationship = card.querySelector("details")!;
    await act(async () => relationship.querySelector("summary")!.click());
    expect(relationship.open).toBe(true);
    expect(card.querySelectorAll("li")).toHaveLength(2); expect(card.querySelector("li li")?.textContent).toContain("Nested child");
    expect(card.textContent).toContain("Parent: codex/archived-ui-child"); expect(card.textContent).toContain("Completed"); expect(card.textContent).toContain("Failed");
    expect(card.textContent).toContain("Child result"); expect(card.textContent).toContain("Partial result"); expect(card.textContent).toContain("Review failed");
  });
  it.each([false, true])("restores the complete group through root IPC and rescan, preserving ordinary session routes (web=%s)", async (web) => {
    runtime.web = web;
    await render();
    await act(async () => button(container, "Restore entire task group").click());
    expect(invoke).toHaveBeenCalledWith("task_group_action", { ...identity, action: "restore" });
    expect(ipc.rescanSessions).toHaveBeenCalledOnce(); expect(useChatStore.getState().refreshSessions).toHaveBeenCalledOnce();
    expect(ipc.restoreSession).not.toHaveBeenCalled(); expect(container.querySelector("[data-leader-archived-group]")).toBeNull();
    await act(async () => button(container, "Restore").click());
    expect(ipc.restoreSession).toHaveBeenCalledWith(ordinary.engine, ordinary.sessionId);
  });
  it.each([false, true])("requires explicit whole-root/all descendants irreversible deletion confirmation and sends no child deletes (web=%s)", async (web) => {
    runtime.web = web;
    await render();
    await act(async () => button(container, "Delete entire task group").click());
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
    let dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("root and all 2 descendant conversations"); expect(dialog.textContent).toContain("cannot be undone");
    await act(async () => button(dialog, "Cancel").click()); expect(snapshot.archivedGroups).toHaveLength(1);
    await act(async () => button(container, "Delete entire task group").click()); dialog = document.body.querySelector('[role="dialog"]')!;
    await act(async () => button(dialog, "Delete entire task group").click());
    expect(invoke).toHaveBeenCalledWith("task_group_action", { ...identity, action: "delete" });
    expect(ipc.deleteSession).not.toHaveBeenCalled(); expect(ipc.deleteRemoteSession).not.toHaveBeenCalled();
  });
  it("guards simultaneous group and ordinary actions, retains the card on error, and permits retry", async () => {
    await render();
    let reject!: (error: Error) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await act(async () => { button(container, "Restore entire task group").click(); button(container, "Restore entire task group").click(); });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "task_group_action")).toHaveLength(1);
    expect(button(container, "Restore").disabled).toBe(true); expect(button(container, "Delete entire task group").disabled).toBe(true);
    await act(async () => reject(new Error("Group restore unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Group restore unavailable");
    expect(container.querySelector("[data-leader-archived-group]")).toBeTruthy(); expect(button(container, "Restore entire task group").disabled).toBe(false);
    await act(async () => button(container, "Restore entire task group").click()); expect(container.querySelector("[data-leader-archived-group]")).toBeNull();
  });
  it("accepts old snapshots without archivedGroups and keeps normal archive deletion behavior", async () => {
    snapshot = { leaders: [], branches: [] };
    await render(); expect(container.textContent).toContain("Ordinary archive"); expect(container.querySelector("[data-leader-archived-group]")).toBeNull();
    await act(async () => button(container, "Delete").click());
    await act(async () => button(document.body.querySelector('[role="dialog"]')!, "Confirm").click());
    expect(ipc.deleteSession).toHaveBeenCalledWith(ordinary.engine, ordinary.sessionId);
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
  });
  it("warns when deletion has started, disables restoration, and requires confirmation before retrying whole-group deletion", async () => {
    snapshot.archivedGroups![0].deletionStarted = true;
    await render();
    const card = container.querySelector("[data-leader-archived-group]")!;
    expect(card.querySelector('[role="alert"]')?.textContent).toBe("Deletion incomplete; already deleted records cannot be restored. Retry deleting the whole group to finish.");
    expect(button(card, "Restore entire task group").disabled).toBe(true);
    expect(container.textContent).not.toContain("Duplicated");
    await act(async () => button(card, "Restore entire task group").click());
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
    expect(ipc.restoreSession).not.toHaveBeenCalled();
    const retry = button(card, "Retry deleting entire task group"); expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("root and all 2 descendant conversations");
    await act(async () => button(dialog, "Delete entire task group").click());
    expect(invoke).toHaveBeenCalledWith("task_group_action", { ...identity, action: "delete" });
    expect(ipc.deleteSession).not.toHaveBeenCalled();
  });
});
