import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  gitStage: vi.fn(), gitUnstage: vi.fn(), gitDiscard: vi.fn(), gitCommit: vi.fn(),
  gitPush: vi.fn(), gitPull: vi.fn(), gitCheckout: vi.fn(), gitCreateBranch: vi.fn(),
  gitStatus: vi.fn(), gitBranches: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: native }));
vi.mock("@/features/files/store", () => ({ useFilesStore: { getState: () => ({ refreshTree: vi.fn() }) } }));
import { useGitStore } from "./store";
import { abortRuntimeCheckpoint, getRuntimeActivityReadiness, holdRuntimeSubmissions, initializeRuntimeCheckpoint } from "@/lib/runtime-checkpoint";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const mutations = [
  ["stage", "gitStage", ["/repo", ["file"]]], ["unstage", "gitUnstage", ["/repo", ["file"]]],
  ["discard", "gitDiscard", ["/repo", ["file"]]], ["commit", "gitCommit", ["/repo", "message"]],
  ["push", "gitPush", ["/repo"]], ["pull", "gitPull", ["/repo"]],
  ["checkout", "gitCheckout", ["/repo", "branch"]], ["createBranch", "gitCreateBranch", ["/repo", "branch"]],
] as const;
describe("Git mutation submission barrier", () => {
  beforeEach(() => {
    initializeRuntimeCheckpoint(undefined, { requiredParticipants: [] });
    for (const mock of Object.values(native)) mock.mockReset().mockResolvedValue(undefined);
    native.gitStatus.mockResolvedValue({ branch: "main", staged: [], unstaged: [], untracked: [], ahead: 0, behind: 0 });
    native.gitBranches.mockResolvedValue([]);
    useGitStore.setState({ fetchedAtByWorkspace: {}, notRepoByWorkspace: {}, errorByWorkspace: {} });
  });
  afterEach(() => abortRuntimeCheckpoint());
  it.each(mutations)("rejects direct %s calls during a hold without invoking native mutation", async (method, command, args) => {
    const release = holdRuntimeSubmissions();
    try {
      const invoke = () => Reflect.apply(useGitStore.getState()[method], undefined, args);
      let work: Promise<unknown> | undefined;
      expect(() => { work = invoke(); }).not.toThrow();
      await expect(work).rejects.toThrow(/paused/);
      expect(native[command]).not.toHaveBeenCalled();
    } finally { release(); }
  });
  it.each([false, true])("owns a direct push through settlement, including failure=%s", async failed => {
    const gate = deferred<void>(); native.gitPush.mockReturnValueOnce(gate.promise);
    const work = useGitStore.getState().push("/repo");
    const outcome = work.catch(error => error);
    expect(getRuntimeActivityReadiness()).toContainEqual({ participant: "operation", reason: "git-mutation" });
    expect(() => holdRuntimeSubmissions()).toThrow(/git-mutation/);
    if (failed) gate.reject(new Error("push failed")); else gate.resolve();
    const result = await outcome;
    if (failed) expect(result).toMatchObject({ message: "push failed" });
    expect(getRuntimeActivityReadiness()).toEqual([]);
    holdRuntimeSubmissions()();
  });
  it("preserves mutation results and permits read-only refresh during the hold", async () => {
    native.gitCommit.mockResolvedValueOnce("commit-sha");
    await expect(useGitStore.getState().commit("/repo", "message")).resolves.toBe("commit-sha");
    const release = holdRuntimeSubmissions();
    try {
      await useGitStore.getState().refresh("/other", true);
      await useGitStore.getState().loadBranches("/other");
      expect(native.gitStatus).toHaveBeenCalledWith("/other");
      expect(native.gitBranches).toHaveBeenCalledWith("/other");
    } finally { release(); }
  });
});
