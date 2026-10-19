import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { GitStatus, Workspace } from "@/lib/ipc";

const gitStatusMock = vi.fn();
const gitBranchesMock = vi.fn();
const gitWorktreeListMock = vi.fn();
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    gitStatus: (...args: unknown[]) => gitStatusMock(...args),
    gitBranches: (...args: unknown[]) => gitBranchesMock(...args),
    gitWorktreeList: (...args: unknown[]) => gitWorktreeListMock(...args),
  },
}));

import { useGitStore } from "@/features/git/store";
import { useWorktreeStore } from "./store";
import { WorktreeCreateDialog } from "./WorktreeCreateDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PARENT = {
  id: "p1",
  path: "/repo/app",
  name: "app",
  lastOpenedAt: null,
  sortOrder: 0,
  groupId: null,
} as Workspace;

const BRANCHES = [
  { name: "main", isRemote: false },
  { name: "v1.0.9", isRemote: false },
  { name: "origin/main", isRemote: true },
];

function status(branch: string): GitStatus {
  return { branch, staged: [], unstaged: [], untracked: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;

// ModalShell 走 portal 渲染到 body，查询必须在 document.body 上做。
// base 下拉的触发器是「新分支」页签里唯一带 git-branch 图标的按钮。
function baseTrigger(): HTMLButtonElement {
  const trigger = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.querySelector(".lucide-git-branch") != null,
  );
  expect(trigger).toBeTruthy();
  return trigger!;
}

function row(text: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    ) ?? null
  );
}

/** 键盘开下拉：jsdom 没有 PointerEvent，react-aria 走"仅测试用"的 mouse 兜底
 *  分支，合成 mouse 事件序列时好时坏；keydown/keyup 这条路稳定。 */
async function openBaseDropdown() {
  const trigger = baseTrigger();
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
}

function render() {
  act(() => {
    root.render(<WorktreeCreateDialog parent={PARENT} onClose={() => undefined} />);
  });
}

describe("WorktreeCreateDialog 默认 base", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGitStore.setState({
      statusByWorkspace: {},
      branchesByWorkspace: {},
      fetchedAtByWorkspace: {},
      notRepoByWorkspace: {},
      errorByWorkspace: {},
    });
    useWorktreeStore.setState({ pending: [], prefs: { location: null, openSessionAfter: true } });
    gitBranchesMock.mockResolvedValue(BRANCHES);
    gitWorktreeListMock.mockResolvedValue([]);
    gitStatusMock.mockResolvedValue(status("v1.0.9"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("默认取当前分支，而不是远程 main", async () => {
    render();
    await act(async () => {});
    expect(gitStatusMock).toHaveBeenCalledWith(PARENT.path);
    expect(baseTrigger().textContent).toBe("v1.0.9");
  });

  it("当前分支是 main 时默认 origin/main（本地 main 可能落后）", async () => {
    gitStatusMock.mockResolvedValue(status("main"));
    render();
    await act(async () => {});
    expect(baseTrigger().textContent).toBe("origin/main");
  });

  it("status 晚于分支列表到达时，默认值跟着当前分支走", async () => {
    const pending = deferred<GitStatus>();
    gitStatusMock.mockReturnValue(pending.promise);
    render();
    // 分支列表先到：还没有当前分支可用，先落回兜底顺序。
    await act(async () => {});
    expect(baseTrigger().textContent).toBe("origin/main");
    await act(async () => pending.resolve(status("v1.0.9")));
    expect(baseTrigger().textContent).toBe("v1.0.9");
  });

  it("手选过 base 后，晚到的 status 不覆盖选择", async () => {
    const pending = deferred<GitStatus>();
    gitStatusMock.mockReturnValue(pending.promise);
    render();
    await act(async () => {});
    await openBaseDropdown();
    const main = row("main");
    expect(main).toBeTruthy();
    act(() => main!.click());
    expect(baseTrigger().textContent).toBe("main");
    await act(async () => pending.resolve(status("v1.0.9")));
    expect(baseTrigger().textContent).toBe("main");
    // 键盘/焦点引发的 react-aria 状态更新收尾，别漏到 act 之外。
    await act(async () => {});
  });
});
