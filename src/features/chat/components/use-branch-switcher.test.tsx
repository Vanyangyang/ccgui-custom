import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBranchSwitcher } from "./use-branch-switcher";

const mocks = vi.hoisted(() => ({
  selectedPath: null as string | null,
  repositories: {} as Record<string, unknown>,
  roots: [] as { path: string; label: string; status: string }[],
  checkout: vi.fn(), refresh: vi.fn(), loadBranches: vi.fn(),
}));
vi.mock("@/features/files/store", () => ({ useFilesStore: (select: (state: typeof mocks) => unknown) => select(mocks) }));
vi.mock("@/features/projects/store", () => ({ useProjectContext: () => ({ roots: mocks.roots }) }));
vi.mock("@/features/git/store", () => {
  const state = { statusByWorkspace: {}, notRepoByWorkspace: {}, branchesByWorkspace: {}, checkout: mocks.checkout, refresh: mocks.refresh, loadBranches: mocks.loadBranches };
  return { useGitStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let result: ReturnType<typeof useBranchSwitcher>;
const active = { workspacePath: "/game" };
function Harness() { result = useBranchSwitcher(active); return <div>{result.branchError}</div>; }
function render() { act(() => root.render(<Harness />)); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectedPath = null;
  mocks.repositories = { "/game": {}, "/plan": {}, "/game/nested": {} };
  mocks.roots = [{ path: "/game", label: "Game", status: "available" }, { path: "/plan", label: "Planning", status: "available" }];
  mocks.checkout.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.loadBranches.mockResolvedValue(undefined);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

it("preserves cwd and nested repository behavior while following a second project root", () => {
  render();
  expect(result.branchRepoName).toBeUndefined();
  act(() => result.handleBranchSelect("main"));
  expect(mocks.checkout).toHaveBeenLastCalledWith("/game", "main");
  mocks.selectedPath = "/game/nested/a.txt";
  render();
  expect(result.branchRepoName).toBe("nested");
  act(() => result.handleBranchSelect("feature"));
  expect(mocks.checkout).toHaveBeenLastCalledWith("/game/nested", "feature");
  mocks.selectedPath = "/plan/readme.md";
  render();
  expect(result.branchRepoName).toBe("Planning");
  act(() => result.handleBranchSelect("docs"));
  expect(mocks.checkout).toHaveBeenLastCalledWith("/plan", "docs");
  expect(mocks.loadBranches).toHaveBeenLastCalledWith("/plan");
  expect(active.workspacePath).toBe("/game");
  mocks.roots = mocks.roots.map((member) => member.path === "/plan" ? { ...member, status: "missing" } : member);
  render();
  act(() => result.handleBranchSelect("main"));
  expect(mocks.checkout).toHaveBeenLastCalledWith("/game", "main");
});

it("captures the original checkout target and suppresses late errors after switching away and back", async () => {
  let reject!: (error: Error) => void;
  mocks.checkout.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render();
  act(() => result.handleBranchSelect("old"));
  mocks.selectedPath = "/plan";
  render();
  mocks.selectedPath = "/game";
  render();
  await act(async () => reject(new Error("old checkout failed")));
  expect(result.branchError).toBeNull();
  expect(mocks.checkout).toHaveBeenCalledExactlyOnceWith("/game", "old");
});

it("shows current failures but hides them on target changes and ignores unmounted results", async () => {
  mocks.checkout.mockRejectedValueOnce(new Error("current checkout failed"));
  render();
  await act(async () => result.handleBranchSelect("bad"));
  expect(result.branchError).toBe("current checkout failed");
  mocks.selectedPath = "/plan";
  render();
  expect(result.branchError).toBeNull();
  let reject!: (error: Error) => void;
  mocks.checkout.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  act(() => result.handleBranchSelect("pending"));
  act(() => root.render(<div />));
  await act(async () => reject(new Error("unmounted checkout failed")));
  render();
  expect(result.branchError).toBeNull();
});
