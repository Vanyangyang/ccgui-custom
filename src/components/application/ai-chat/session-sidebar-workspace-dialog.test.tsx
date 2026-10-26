import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc, type SessionMeta, type Workspace } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { SessionSidebarWorkspaceDialog, sidebarAssignmentError, isLocalSidebarWorkspace } from "./session-sidebar-workspace-dialog";
import { ThreadContextMenu } from "./thread-context-menu";
import { useLeaderStore } from "@/features/leader/store";
import type { LeaderBranch } from "@/features/leader/types";

vi.mock("@/components/dialogs", () => ({ ModalShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const session = { engine: "codex", sessionId: "test-root", workspacePath: "G:/execution", sidebarWorkspacePath: "G:/old" } as SessionMeta;
let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  useChatStore.setState({ workspaceAliases: {}, workspaces: [
    { id: "target", path: "G:/sorted", name: "Sorted" },
    { id: "remote", path: "wsl://ubuntu/project", name: "Remote", meta: { wsl: {} } },
  ] as Workspace[] });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

it("submits sidebar-only compare-and-set values and offers clearing", async () => {
  const assign = vi.spyOn(ipc, "assignSessionSidebarWorkspaces").mockResolvedValue();
  const close = vi.fn();
  await act(async () => root.render(<SessionSidebarWorkspaceDialog session={session} onClose={close} />));
  const select = node.querySelector("select")!;
  expect([...select.options].map((o) => o.value)).toEqual(["", "G:/old", "G:/sorted"]);
  expect(node.textContent).toContain("G:/execution");
  await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button")[1].click());
  expect(assign).toHaveBeenCalledWith(expect.any(String), [{ engine: "codex", sessionId: "test-root", expectedWorkspacePath: "G:/execution", expectedSidebarWorkspacePath: "G:/old", sidebarWorkspacePath: null }]);
  expect(close).toHaveBeenCalledOnce();
});

it("keeps the dialog open and shows session identity and reason on conflict", async () => {
  vi.spyOn(ipc, "assignSessionSidebarWorkspaces").mockRejectedValue(JSON.stringify({ code: "SESSION_SIDEBAR_ASSIGNMENT_CONFLICT", conflicts: [{ engine: "codex", sessionId: "test-root", code: "SIDEBAR_WORKSPACE_CHANGED", message: "changed" }] }));
  const close = vi.fn();
  await act(async () => root.render(<SessionSidebarWorkspaceDialog session={session} onClose={close} />));
  await act(async () => { const select = node.querySelector("select")!; select.value = "G:/sorted"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button")[1].click());
  expect(close).not.toHaveBeenCalled();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("codex/test-root");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("chat.sidebarWorkspaceConflicts.SIDEBAR_WORKSPACE_CHANGED"));
  expect(sidebarAssignmentError({ message: "unavailable" }, i18n.t.bind(i18n))).toContain("unavailable");
});

it("offers sidebar assignment for a root, but not a managed child", async () => {
  const original = useLeaderStore.getState().snapshot;
  useChatStore.setState({ sessions: [session], workspaces: [{ id: "source", path: session.workspacePath, name: "Source" } as Workspace] });
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] } });
  try {
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "codex/test-root" }} onClose={() => {}} onSidebarWorkspace={() => {}} />));
    const entries = () => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(entries()).toContain(i18n.t("chat.sidebarWorkspace"));
    await act(async () => useChatStore.setState({ sessions: [{ ...session, auxiliaryKind: "cursor_cce" }] }));
    expect(entries()).not.toContain(i18n.t("chat.sidebarWorkspace"));
    await act(async () => useChatStore.setState({ sessions: [session] }));
    await act(async () => useLeaderStore.setState({ snapshot: { leaders: [], branches: [{
      id: "branch", engine: "codex", sessionId: "test-root", parentEngine: "codex", parentSessionId: "parent", workspacePath: session.workspacePath, state: "completed",
    } as LeaderBranch] } }));
    expect(entries()).not.toContain(i18n.t("chat.sidebarWorkspace"));
    await act(async () => useLeaderStore.setState({ snapshot: { leaders: [], branches: [{
      id: "branch", engine: "codex", sessionId: "test-root", parentEngine: "codex", parentSessionId: "parent", workspacePath: session.workspacePath, state: "reclaimed",
    } as LeaderBranch] } }));
    expect(entries()).not.toContain(i18n.t("chat.sidebarWorkspace"));
  } finally { await act(async () => useLeaderStore.setState({ snapshot: original })); }
});

it("excludes raw remote paths and remote metadata even when the value is null", () => {
  for (const path of ["wsl://ubuntu/project", "ssh://host/project", "\\\\server\\share", "//server/share", "relative"]) {
    expect(isLocalSidebarWorkspace({ path } as Workspace)).toBe(false);
  }
  for (const key of ["remote", "wsl", "ssh"]) {
    expect(isLocalSidebarWorkspace({ path: "G:/project", meta: { [key]: null } } as Workspace)).toBe(false);
  }
  expect(isLocalSidebarWorkspace({ path: "G:/project" } as Workspace)).toBe(true);
  expect(isLocalSidebarWorkspace({ path: "/home/project" } as Workspace)).toBe(true);
});

it("ignores an old save completion after a different session dialog mounts", async () => {
  let resolve!: () => void;
  vi.spyOn(ipc, "assignSessionSidebarWorkspaces").mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  const oldClose = vi.fn();
  const newClose = vi.fn();
  await act(async () => root.render(<SessionSidebarWorkspaceDialog key="old" session={session} onClose={oldClose} />));
  await act(async () => { const select = node.querySelector("select")!; select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => node.querySelectorAll<HTMLButtonElement>("button")[1].click());
  await act(async () => root.render(<SessionSidebarWorkspaceDialog key="new" session={{ ...session, sessionId: "new", sidebarWorkspacePath: null }} onClose={newClose} />));
  await act(async () => resolve());
  expect(oldClose).not.toHaveBeenCalled();
  expect(newClose).not.toHaveBeenCalled();
  expect(node.querySelector("select")?.value).toBe("");
});
