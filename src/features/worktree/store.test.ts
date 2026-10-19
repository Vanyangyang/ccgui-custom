import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeCreateArgs, WorktreeCreateProgress } from "@/lib/ipc";

const createMock = vi.fn();
const cancelMock = vi.fn();
const listMock = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    gitWorktreeCreate: (...args: unknown[]) => createMock(...args),
    gitWorktreeCreateCancel: (...args: unknown[]) => cancelMock(...args),
    gitWorktreeList: (...args: unknown[]) => listMock(...args),
  },
}));

const listenMock = vi.fn();
const invokeMock = vi.fn();
vi.mock("@/lib/transport", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const refreshWorkspacesMock = vi.fn();
const startNewChatMock = vi.fn();
vi.mock("@/features/chat/store", () => ({
  useChatStore: {
    getState: () => ({
      refreshWorkspaces: refreshWorkspacesMock,
      startNewChat: startNewChatMock,
      workspaces: [],
    }),
  },
}));

const dismissCenterSurfacesMock = vi.fn();
vi.mock("@/features/chat/center-surfaces", () => ({
  dismissCenterSurfaces: dismissCenterSurfacesMock,
}));

// vi.mock 提升后静态导入拿到的是 mock 版。
import { useWorktreeStore, refreshWorktreeSnapshot, startWorktreeRuntime, stopWorktreeRuntime,
  type WorktreeCreationSnapshot } from "./store";

const ARGS: WorktreeCreateArgs = {
  repoPath: "/repo/app",
  parentWorkspaceId: "ws-parent",
  branch: "pr-1842-x",
  worktreePath: "/repo/app-worktrees/pr-1842-x",
  baseRef: null,
  prNumber: 1842,
  prTitle: "Add worktree support",
  prUrl: "https://github.com/o/r/pull/1842",
  existingBranch: false,
};

function progress(
  creationId: string,
  stage: WorktreeCreateProgress["stage"],
  extra: Partial<WorktreeCreateProgress> = {},
): WorktreeCreateProgress {
  return { creationId, stage, ...extra };
}

function startOne(openSessionAfter = true): string {
  useWorktreeStore.getState().start(ARGS, { parentPath: ARGS.repoPath, openSessionAfter });
  return useWorktreeStore.getState().pending.at(-1)!.creationId;
}

describe("worktree store", () => {
  beforeEach(() => {
    stopWorktreeRuntime();
    localStorage.clear();
    useWorktreeStore.setState({ pending: [], prefs: { location: null, openSessionAfter: true } });
    createMock.mockReset().mockResolvedValue(undefined);
    cancelMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    invokeMock.mockReset().mockResolvedValue([]);
    listMock.mockReset().mockResolvedValue([]);
    refreshWorkspacesMock.mockReset().mockResolvedValue(undefined);
    startNewChatMock.mockReset();
    dismissCenterSurfacesMock.mockReset();
  });

  it("start registers a pending row and launches the backend pipeline", () => {
    const id = startOne();
    const state = useWorktreeStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({
      creationId: id,
      parentWorkspaceId: "ws-parent",
      branch: "pr-1842-x",
      stage: "validate",
    });
    expect(createMock).toHaveBeenCalledWith(id, ARGS);
    expect(listenMock).toHaveBeenCalledWith("worktree://create-progress", expect.any(Function));
  });

  it("running progress updates stage and detail on the matching row only", () => {
    const id = startOne();
    const other = startOne();
    useWorktreeStore.getState().applyProgress(progress(id, "fetch", { message: "origin main" }));
    const [first, second] = useWorktreeStore.getState().pending;
    expect(first).toMatchObject({ creationId: id, stage: "fetch", detail: "origin main" });
    expect(second).toMatchObject({ creationId: other, stage: "validate" });
  });

  it("progress for an unknown creationId is ignored", () => {
    startOne();
    useWorktreeStore.getState().applyProgress(progress("ghost", "add"));
    expect(useWorktreeStore.getState().pending[0].stage).toBe("validate");
  });

  it("done removes the row, refreshes workspaces, then clears surfaces and opens a chat", async () => {
    const id = startOne(true);
    useWorktreeStore.getState().applyProgress(progress(id, "done"));

    expect(useWorktreeStore.getState().pending).toHaveLength(0);
    await vi.waitFor(() => expect(startNewChatMock).toHaveBeenCalledWith(ARGS.worktreePath));
    expect(refreshWorkspacesMock).toHaveBeenCalled();
    expect(dismissCenterSurfacesMock).toHaveBeenCalled();
  });

  it("done without openSessionAfter refreshes but does not open a chat", async () => {
    const id = startOne(false);
    useWorktreeStore.getState().applyProgress(progress(id, "done"));

    await vi.waitFor(() => expect(refreshWorkspacesMock).toHaveBeenCalled());
    expect(startNewChatMock).not.toHaveBeenCalled();
    expect(dismissCenterSurfacesMock).not.toHaveBeenCalled();
  });

  it("failed keeps the row with the error kind for retry", () => {
    const id = startOne();
    useWorktreeStore
      .getState()
      .applyProgress(progress(id, "failed", { errorKind: "fetch_failed", error: "boom" }));
    const row = useWorktreeStore.getState().pending[0];
    expect(row).toMatchObject({ stage: "failed", errorKind: "fetch_failed", error: "boom" });
  });

  it("cancel forwards to the backend cancellation registry", () => {
    const id = startOne();
    useWorktreeStore.getState().cancel(id);
    expect(cancelMock).toHaveBeenCalledWith(id);
  });

  it("retry relaunches a failed creation with a fresh id and the same args", () => {
    const id = startOne();
    useWorktreeStore.getState().applyProgress(progress(id, "failed", { errorKind: "unknown" }));

    useWorktreeStore.getState().retry(id);

    const state = useWorktreeStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0].creationId).not.toBe(id);
    expect(state.pending[0].stage).toBe("validate");
    expect(createMock).toHaveBeenLastCalledWith(state.pending[0].creationId, ARGS);
  });

  it("retry on a still-running creation is a no-op", () => {
    const id = startOne();
    createMock.mockClear();
    useWorktreeStore.getState().retry(id);
    expect(createMock).not.toHaveBeenCalled();
    expect(useWorktreeStore.getState().pending[0].creationId).toBe(id);
  });

  it("an invoke rejection (event never arrives) fails the row instead of spinning forever", async () => {
    createMock.mockRejectedValueOnce(new Error("ipc down"));
    const id = startOne();
    await vi.waitFor(() => {
      expect(useWorktreeStore.getState().pending[0].stage).toBe("failed");
    });
    expect(useWorktreeStore.getState().pending[0].creationId).toBe(id);
  });

  it("dismiss removes the row without touching the backend", () => {
    const id = startOne();
    useWorktreeStore.getState().applyProgress(progress(id, "failed"));
    useWorktreeStore.getState().dismiss(id);
    expect(useWorktreeStore.getState().pending).toHaveLength(0);
  });

  it("setPrefs persists to localStorage", () => {
    useWorktreeStore.getState().setPrefs({ location: "/custom/dir", openSessionAfter: false });
    const raw = localStorage.getItem("ccgui-next.worktreePrefs:v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ location: "/custom/dir", openSessionAfter: false });
  });

  const snapshot = (id: string, stage: WorktreeCreateProgress["stage"], revision: number): WorktreeCreationSnapshot => ({
    args: ARGS, progress: { creationId: id, stage, revision },
    active: !["done", "failed", "canceled"].includes(stage),
  });

  it("a second client imports active work then settles without opening a chat or creating again", async () => {
    useWorktreeStore.getState().applySnapshot([snapshot("other-client", "fetch", 10)]);
    expect(useWorktreeStore.getState().pending[0]).toMatchObject({
      creationId: "other-client", stage: "fetch", hostRevision: 10, openSessionAfter: false,
    });
    useWorktreeStore.getState().cancel("other-client");
    expect(cancelMock).toHaveBeenCalledWith("other-client");
    useWorktreeStore.getState().applySnapshot([snapshot("other-client", "done", 11)]);
    await vi.waitFor(() => expect(refreshWorkspacesMock).toHaveBeenCalled());
    expect(useWorktreeStore.getState().pending).toEqual([]);
    expect(startNewChatMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("late snapshots cannot roll back newer events or revive completed and dismissed rows", () => {
    useWorktreeStore.getState().applySnapshot([snapshot("late", "fetch", 20)]);
    useWorktreeStore.getState().applyProgress({ creationId: "late", stage: "register", revision: 22 });
    useWorktreeStore.getState().applySnapshot([snapshot("late", "add", 21)]);
    expect(useWorktreeStore.getState().pending[0].stage).toBe("register");
    useWorktreeStore.getState().applyProgress({ creationId: "late", stage: "done", revision: 23 });
    useWorktreeStore.getState().applySnapshot([snapshot("late", "fetch", 20)]);
    expect(useWorktreeStore.getState().pending).toEqual([]);
    useWorktreeStore.getState().applySnapshot([snapshot("dismissed-host", "failed", 24)]);
    useWorktreeStore.getState().dismiss("dismissed-host");
    useWorktreeStore.getState().applySnapshot([snapshot("dismissed-host", "failed", 24)]);
    expect(useWorktreeStore.getState().pending).toEqual([]);
  });

  it("initial mount and reconnect read snapshots, with subscription cleanup", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const offs: ReturnType<typeof vi.fn>[] = [];
    listenMock.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
      handlers.set(name, callback);
      const off = vi.fn(); offs.push(off); return off;
    });
    invokeMock.mockResolvedValue([snapshot("initial-host", "add", 30)]);
    const stop = startWorktreeRuntime();
    await vi.waitFor(() => expect(useWorktreeStore.getState().pending[0]?.stage).toBe("add"));
    invokeMock.mockResolvedValue([snapshot("initial-host", "canceled", 31)]);
    handlers.get("transport://connected")!({ payload: null });
    await vi.waitFor(() => expect(useWorktreeStore.getState().pending[0]?.stage).toBe("canceled"));
    expect(invokeMock).toHaveBeenCalledWith("git_worktree_creation_snapshot");
    expect(createMock).not.toHaveBeenCalled();
    stop();
    expect(offs).toHaveLength(3);
    expect(offs.every((off) => off.mock.calls.length === 1)).toBe(true);
  });

  it("a disconnected create is recovered from host state without resending the command", async () => {
    createMock.mockRejectedValueOnce(new Error("connection closed"));
    const id = startOne();
    invokeMock.mockResolvedValue([snapshot(id, "fetch", 40)]);
    await vi.waitFor(() => expect(useWorktreeStore.getState().pending[0]?.stage).toBe("fetch"));
    expect(useWorktreeStore.getState().pending[0].uncertain).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(id, ARGS);
  });

  it("missing registry state shows uncertainty and reads actual worktrees without retrying", async () => {
    useWorktreeStore.getState().applySnapshot([snapshot("lost-host", "add", 50)]);
    listMock.mockResolvedValue([{ path: ARGS.worktreePath, branch: ARGS.branch, head: "abc", isMain: false, locked: false, prunable: true }]);
    await refreshWorktreeSnapshot();
    expect(useWorktreeStore.getState().pending[0]).toMatchObject({ stage: "failed", uncertain: true });
    expect(listMock).toHaveBeenCalledWith(ARGS.repoPath);
    expect(useWorktreeStore.getState().missingPaths[ARGS.worktreePath]).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a snapshot response arriving after cleanup cannot import a row", async () => {
    let resolve!: (value: WorktreeCreationSnapshot[]) => void;
    invokeMock.mockReturnValue(new Promise<WorktreeCreationSnapshot[]>((done) => { resolve = done; }));
    const read = refreshWorktreeSnapshot();
    stopWorktreeRuntime();
    resolve([snapshot("after-cleanup", "add", 60)]);
    await read;
    expect(useWorktreeStore.getState().pending).toEqual([]);
  });
});
