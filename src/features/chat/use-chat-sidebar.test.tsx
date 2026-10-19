import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { AiChatRepo } from "@/components/application/ai-chat/ai-chat-sidebar";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import { useBrowserStore } from "@/features/browser/store";
import { useFilesStore } from "@/features/files/store";
import { useGitStore } from "@/features/git/store";
import { resetMissionStore, useMissionStore } from "@/features/mission/store";
import { usePluginHubStore } from "@/features/plugins/hub/store";
import { usePluginTabsStore } from "@/features/plugins/runtime/center-tabs";
import { useChatStore } from "./store";
import { useChatSidebar } from "./use-chat-sidebar";
import { useLeaderStore } from "@/features/leader/store";
import { pickDirectory } from "@/lib/platform";
import { WorkspaceSection } from "@/components/application/ai-chat/workspace-sections";

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),

  
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/platform", () => ({
  isWeb: true,
  pickDirectory: vi.fn(async () => null),
}));
// 聚焦助手自带 rAF 重试窗口，单测里只关心语义。
vi.mock("./focus-composer", () => ({ focusComposerWhenVisible: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const WS: Workspace = {
  id: "w1",
  path: "/ws/a",
  name: "a",
  sortOrder: 0,
  groupId: null,
} as Workspace;

const SESSION: SessionMeta = {
  engine: "codex",
  sessionId: "s-1",
  workspacePath: "/ws/a",
  filePath: "/local/s-1.jsonl",
  fileSize: 1,
  fileMtimeMs: 1,
  title: "local",
  preview: "",
  createdAt: null,
  updatedAt: 1,
  messageCount: 1,
  pinned: false,
  customTitle: null,
};

let container: HTMLDivElement;
let root: Root;
let captured: AiChatRepo[];
let sidebar: ReturnType<typeof useChatSidebar>;

function Harness() {
  const streaming = useChatStore((s) => s.streamingByKey["codex/s-1"] === true);
  const retrying = useChatStore((s) => s.retryingByKey["codex/s-1"] === true);
  sidebar = useChatSidebar({
    sessionById: new Map(),
    threadStreaming: [streaming],
    threadRetrying: [retrying],
    collapseSidebarOnMobile: () => {},
    composerInputRef: { current: null },
    setDialog: () => {},
  });
  captured = sidebar.repos;
  return null;
}

describe("useChatSidebar repo mapping", () => {
  it("passes structured auxiliary classification through without title inference", async () => {
    await act(async () => useChatStore.setState({ sessions: [{ ...SESSION, auxiliaryKind: "cursor_cce" }] }));
    expect(captured[0].threads[0].auxiliaryKind).toBe("cursor_cce");
    await act(async () => useChatStore.setState({ sessions: [{ ...SESSION, title: "cursor_context_engine" }] }));
    expect(captured[0].threads[0].auxiliaryKind).toBeUndefined();
  });
  beforeEach(async () => {
    useChatStore.setState({
      workspaces: [WS],
      sessions: [SESSION],
      openTabs: [],
      threadLimit: 7,
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      retryingByKey: {},
      streamingByKey: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      window.__ccguiWorkspaceUI?.registerHooks(null);
      root.unmount();
    });
    container.remove();
  });

  it("threadLimit 透传到 repo(分页折叠依赖它,删了设置就失效)", () => {
    expect(captured).toHaveLength(1);
    expect(captured[0]?.threadLimit).toBe(7);
    expect(captured[0]?.threads.map((t) => t.id)).toEqual(["codex/s-1"]);
  });

  it("includes saved sessions and drafts when a Windows workspace has repeated separators", async () => {
    const workspacePath = String.raw`C:\\Users\\demo\\Documents\\Projects\\example-app`;
    const sessionPath = String.raw`C:\Users\demo\Documents\Projects\example-app`;
    const draftPath = "C:/Users/demo/Documents/Projects/example-app";
    await act(async () => {
      useChatStore.setState({
        workspaces: [{ ...WS, path: workspacePath }],
        sessions: [{ ...SESSION, workspacePath: sessionPath }],
        openTabs: [{ engine: "codex", sessionId: null, workspacePath: draftPath }],
      });
    });
    expect(captured[0]?.threads.map((thread) => thread.id)).toEqual([
      `new:codex:${draftPath}`,
      "codex/s-1",
    ]);
    expect(captured[0]?.path).toBe(workspacePath);
  });

  it("offers the remote add button and registers the chosen host path, preserving cancellation", async () => {
    const originalAdd = useChatStore.getState().addWorkspace;
    const add = vi.fn(async () => {});
    await act(async () => useChatStore.setState({ addWorkspace: add }));
    vi.mocked(pickDirectory).mockClear().mockResolvedValueOnce("G:/host/project").mockResolvedValueOnce(null);
    try {
      await act(async () => root.render(<><Harness /><WorkspaceSection repos={[]} collapsedGroups={new Set()} isRepoExpanded={() => false} onToggleRepo={() => {}} onAddWorkspace={() => sidebar.handleAddWorkspace()} /></>));
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="添加工作区"]')!;
      expect(button).toBeTruthy();
      await act(async () => button.click());
      expect(pickDirectory).toHaveBeenCalledWith("添加工作区");
      expect(add).toHaveBeenCalledExactlyOnceWith("G:/host/project");
      await act(async () => button.click());
      expect(add).toHaveBeenCalledTimes(1);
    } finally { await act(async () => useChatStore.setState({ addWorkspace: originalAdd })); }
  });

  it("pending 新对话出现在对应工作区线程列表顶部", async () => {
    await act(async () => {
      useChatStore.setState({
        openTabs: [{ engine: "codex", sessionId: null, workspacePath: "/ws/a" }],
        active: { engine: "codex", sessionId: null, workspacePath: "/ws/a" },
      });
    });
    expect(captured[0]?.threads.map((thread) => thread.id)).toEqual([
      "new:codex:/ws/a",
      "codex/s-1",
    ]);
    expect(captured[0]?.threads[0]).toMatchObject({
      label: "新对话",
      isDraft: true,
      engine: "codex",
    });
  });

  it("worktree 子工作区挂到父行下，标签用分支名并带 PR 元数据", async () => {
    const WT = {
      id: "wt1",
      path: "/ws/a-worktrees/pr-1842",
      name: "pr-1842",
      lastOpenedAt: null,
      sortOrder: 1,
      groupId: null,
      kind: "worktree",
      parentId: "w1",
      meta: { worktree: { branch: "pr-1842-fix-crash", prNumber: 1842 } },
    } as Workspace;
    await act(async () => {
      useChatStore.setState({
        workspaces: [WS, WT],
        sessions: [SESSION, { ...SESSION, sessionId: "s-wt", workspacePath: WT.path }],
      });
    });
    // 顶层只剩父行；子行连同自己的会话挂进 worktrees。
    expect(captured.map((r) => r.id)).toEqual(["w1"]);
    const child = captured[0]?.worktrees?.[0];
    expect(child).toMatchObject({
      id: "wt1",
      path: WT.path,
      label: "pr-1842-fix-crash",
      originalLabel: "pr-1842",
      worktree: { branch: "pr-1842-fix-crash", prNumber: 1842 },
    });
    expect(child?.threads.map((t) => t.id)).toEqual(["codex/s-wt"]);
  });

  it("父行不可见（已归档/被移除）时 worktree 降级为普通顶层行", async () => {
    const WT = {
      id: "wt1",
      path: "/ws/a-worktrees/pr-1842",
      name: "pr-1842",
      lastOpenedAt: null,
      sortOrder: 1,
      groupId: null,
      kind: "worktree",
      parentId: "w1",
      meta: { worktree: { branch: "pr-1842-fix-crash" } },
    } as Workspace;
    await act(async () => {
      useChatStore.setState({
        workspaces: [WS, WT],
        archivedWorkspaces: ["w1"],
      });
    });
    expect(captured.map((r) => r.id)).toEqual(["wt1"]);
    expect(captured[0]?.worktrees).toBeUndefined();
    expect(captured[0]?.label).toBe("pr-1842-fix-crash");
  });

  it("插件桥 hooks 注册后徽标响应式出现(activate/热重载不等无关重渲染)", async () => {
    expect(captured[0]?.labelSuffix).toBeUndefined();
    await act(async () => {
      window.__ccguiWorkspaceUI?.registerHooks({
        allowedEngines: () => null,
        labelSuffix: (p) => (p === "/ws/a" ? "WSL" : null),
      });
    });
    expect(captured[0]?.labelSuffix).toBe("WSL");
  });

  it("maps retrying state to the matching sidebar thread", async () => {
    await act(async () => {
      useChatStore.setState({
        streamingByKey: { "codex/s-1": true },
        retryingByKey: { "codex/s-1": true },
      });
    });

    expect(captured[0]?.threads[0]).toMatchObject({
      streaming: true,
      retrying: true,
    });
  });
});

describe("created task relationship action guards", () => {
  const setDialog = vi.fn();
  const originalLeaderRefresh = useLeaderStore.getState().refresh;
  function ActionHarness() {
    const sessions = useChatStore((s) => s.sessions);
    sidebar = useChatSidebar({ sessionById: new Map(sessions.map((session) => [`${session.engine}/${session.sessionId}`, session])),
      threadStreaming: [], threadRetrying: [], collapseSidebarOnMobile: () => {}, composerInputRef: { current: null }, setDialog });
    return null;
  }
  beforeEach(async () => {
    setDialog.mockClear();
    useChatStore.setState({ workspaces: [WS], sessions: [SESSION], openTabs: [], active: null, workspaceGroups: [], workspaceAliases: {}, archivedWorkspaces: [] });
    useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, managing: null, error: null, busy: false, refresh: originalLeaderRefresh });
    vi.spyOn(useLeaderStore.getState(), "refresh").mockResolvedValue();
    vi.spyOn(useChatStore.getState(), "archiveSession").mockResolvedValue();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<ActionHarness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
    useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, managing: null, error: null, busy: false, refresh: originalLeaderRefresh });
  });
  it.each(["archive", "delete"] as const)("routes stale ordinary %s actions on an archived task group to management without a mode marker", async (action) => {
    const identity = { engine: SESSION.engine, sessionId: SESSION.sessionId, workspacePath: SESSION.workspacePath };
    const staleAction = sidebar.handleThreadAction;
    await act(async () => useLeaderStore.setState({ snapshot: { leaders: [], branches: [],
      archivedGroups: [{ root: identity, title: "Archived task", archivedAt: 1, members: [], branchIds: [] }] } }));
    await act(async () => staleAction("codex/s-1", action));
    expect(useLeaderStore.getState().managing).toEqual(identity);
    expect(useChatStore.getState().archiveSession).not.toHaveBeenCalled(); expect(setDialog).not.toHaveBeenCalled();
  });
  it.each(["legacy-marker", "disabled", "other-workspace", "other-engine"] as const)("preserves ordinary archive/delete actions for an empty %s root identity", async (mode) => {
    const identity = { engine: mode === "other-engine" ? "claude" : SESSION.engine, sessionId: SESSION.sessionId,
      workspacePath: mode === "other-workspace" ? "/different-workspace" : SESSION.workspacePath };
    await act(async () => useLeaderStore.setState({ snapshot: { leaders: mode === "disabled" ? [] : [identity], branches: [] } }));
    await act(async () => { sidebar.handleThreadAction("codex/s-1", "archive"); sidebar.handleThreadAction("codex/s-1", "delete"); });
    expect(useLeaderStore.getState().managing).toBeNull(); expect(useChatStore.getState().archiveSession).toHaveBeenCalledWith(SESSION);
    expect(setDialog).toHaveBeenCalledWith(expect.objectContaining({ kind: "delete", session: SESSION }));
  });
});

/**
 * 中心面互斥：会话入口必须把中心区从其他面（插件中心页、插件页签、浏览器、
 * 任务工作台、文件、差异）切回对话，否则会话新建/选中了，画面却停在原处。
 */
describe("会话入口切回对话中心面", () => {
  beforeEach(async () => {
    useChatStore.setState({
      activeEngine: "codex",
      workspaces: [WS],
      sessions: [SESSION],
      openTabs: [],
      active: null,
      unseen: {},
    });
    useBrowserStore.setState({
      tabs: [{ id: "b1", url: "https://example.com", title: "example" }],
      activeId: "b1",
    });
    useFilesStore.setState({ activeFilePath: "/ws/a/x.ts" });
    useGitStore.setState({
      diffView: { workspacePath: "/ws/a", target: { file: "x.ts", staged: false } },
    });
    resetMissionStore();
    useMissionStore.setState({ open: true, active: true });
    usePluginHubStore.setState({ open: true, active: true, view: "market" });
    usePluginTabsStore.setState({ tabs: ["plugin:demo:main"], activeId: "plugin:demo:main" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useBrowserStore.setState({ tabs: [], activeId: null });
    useFilesStore.setState({ activeFilePath: null });
    useGitStore.setState({ diffView: null });
    resetMissionStore();
    usePluginHubStore.setState({ open: false, active: false, view: "market" });
    usePluginTabsStore.setState({ tabs: [], activeId: null });
  });

  function expectOnlyChatLeft() {
    expect(usePluginHubStore.getState().active).toBe(false);
    expect(usePluginTabsStore.getState().activeId).toBeNull();
    expect(useBrowserStore.getState().activeId).toBeNull();
    expect(useMissionStore.getState().active).toBe(false);
    expect(useFilesStore.getState().activeFilePath).toBeNull();
    expect(useGitStore.getState().diffView).toBeNull();
  }

  it("新建会话（侧栏/+、快捷键走同一入口）切回对话", async () => {
    await act(async () => {
      sidebar.handleNewSession();
    });
    expectOnlyChatLeft();
    expect(useChatStore.getState().active).toEqual({
      engine: "codex",
      sessionId: null,
      workspacePath: "/ws/a",
    });
  });

  it("工作区行的 + 也切回对话", async () => {
    await act(async () => {
      sidebar.handleNewSessionInWorkspace("w1");
    });
    expectOnlyChatLeft();
    expect(useChatStore.getState().active).toMatchObject({ sessionId: null, workspacePath: "/ws/a" });
  });

  it("点击会话线程切回对话（草稿态走 focusTab）", async () => {
    await act(async () => {
      sidebar.handleThreadSelect("new:codex:/ws/a");
    });
    expectOnlyChatLeft();
  });

  it("无原生 ID 的 Leader 分支不能清掉当前中心面", async () => {
    await act(async () => sidebar.handleThreadSelect("leader-branch:pending"));
    expect(usePluginHubStore.getState().active).toBe(true);
    expect(usePluginTabsStore.getState().activeId).toBe("plugin:demo:main");
    expect(useBrowserStore.getState().activeId).toBe("b1");
    expect(useMissionStore.getState().active).toBe(true);
    expect(useFilesStore.getState().activeFilePath).toBe("/ws/a/x.ts");
    expect(useGitStore.getState().diffView).not.toBeNull();
    expect(useChatStore.getState().active).toBeNull();
  });

  it("新建浏览器页签时其他中心面让位（页签高亮与画面一致）", async () => {
    await act(async () => {
      sidebar.handleNewBrowser();
    });
    expect(usePluginHubStore.getState().active).toBe(false);
    expect(usePluginTabsStore.getState().activeId).toBeNull();
    expect(useMissionStore.getState().active).toBe(false);
    expect(useFilesStore.getState().activeFilePath).toBeNull();
    expect(useGitStore.getState().diffView).toBeNull();
    expect(useBrowserStore.getState().activeId).not.toBeNull();
  });
});
