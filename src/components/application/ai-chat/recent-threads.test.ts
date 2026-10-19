import { expect, it } from "vitest";
import { recentThreadsByActivity } from "./recent-threads";
import type { AiChatRepo, AiChatThread } from "./sidebar-types";

function thread(partial: Omit<AiChatThread, "time"> & { time?: string }): AiChatThread {
  return { ...partial, time: partial.time ?? "" };
}

function repo(label: string, threads: AiChatThread[], worktrees?: AiChatRepo[]): AiChatRepo {
  return { id: label, label, threads, worktrees };
}

it("跨工作区按最后对话时间从新到旧，置顶不插队", () => {
  const rows = recentThreadsByActivity([
    repo("旧仓库", [thread({ id: "pinned-old", label: "置顶旧", updatedAt: 1, pinned: true })]),
    repo("新仓库", [thread({ id: "fresh", label: "最新", updatedAt: 50 })]),
  ]);
  expect(rows.map((row) => row.id)).toEqual(["fresh", "pinned-old"]);
  expect(rows.map((row) => row.workspaceLabel)).toEqual(["新仓库", "旧仓库"]);
});

it("草稿置前，根任务按整棵树活动排序并递归保留工作区与子孙顺序", () => {
  const rows = recentThreadsByActivity([
    repo("父仓库", [
      thread({ id: "draft", label: "草稿", isDraft: true }),
      thread({
        id: "parent",
        label: "父会话",
        updatedAt: 10,
        children: [thread({ id: "child", label: "子分支", updatedAt: 2,
          children: [thread({ id: "grandchild", label: "孙分支", updatedAt: 40 })] }),
          thread({ id: "sibling", label: "另一分支", updatedAt: 20 })],
      }),
    ], [
      repo("功能分支", [thread({ id: "wt", label: "分支对话", updatedAt: 30 })]),
    ]),
  ]);
  expect(rows.map((row) => row.id)).toEqual(["draft", "parent", "wt"]);
  expect(rows.find((row) => row.id === "wt")?.workspaceLabel).toBe("功能分支");
  expect(rows[1].children?.map((row) => row.id)).toEqual(["child", "sibling"]);
  expect(rows[1].children?.[0].workspaceLabel).toBe("父仓库");
  expect(rows[1].children?.[0].children?.[0].workspaceLabel).toBe("父仓库");
});

it("没有会话时间戳时改用 Leader 分支的最后活动时间", () => {
  const rows = recentThreadsByActivity([
    repo("任务", [
      thread({ id: "quiet", label: "较早", updatedAt: 5 }),
      thread({
        id: "branch",
        label: "分支",
        leaderBranch: {
          id: "b1",
          parentEngine: "codex",
          parentSessionId: "p",
          workspacePath: "/ws",
          engine: "codex",
          sessionId: null,
          title: "分支",
          task: "",
          model: null,
          effort: null,
          runId: null,
          state: "running",
          createdAt: 1,
          updatedAt: 2,
          lastActivityAt: 80,
          deadlineAt: 90,
          expired: false,
          result: "",
          resultTruncated: false,
          error: null,
        },
      }),
    ]),
  ]);
  expect(rows.map((row) => row.id)).toEqual(["branch", "quiet"]);
});

it("后代草稿使整组置前，同时间保持遍历顺序且不改变输入树", () => {
  const child = thread({ id: "draft-child", label: "draft", isDraft: true });
  const parent = thread({ id: "parent", label: "parent", children: [child] });
  const rows = recentThreadsByActivity([repo("ws", [
    thread({ id: "same-a", label: "a", updatedAt: 20 }), parent,
    thread({ id: "same-b", label: "b", updatedAt: 20 }),
    thread({ id: "draft-root", label: "draft-root", isDraft: true }),
  ])]);
  expect(rows.map((row) => row.id)).toEqual(["parent", "draft-root", "same-a", "same-b"]);
  expect(parent.children).toEqual([child]);
  expect(child.workspaceLabel).toBeUndefined();
  expect(rows[0].children?.[0]).not.toBe(child);
});
