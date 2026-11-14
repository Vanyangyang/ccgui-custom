import { expect, it } from "vitest";
import { recentThreadsByActivity } from "./recent-threads";
import type { AiChatRepo, AiChatThread } from "./sidebar-types";

function thread(partial: Omit<AiChatThread, "time"> & { time?: string }): AiChatThread {
  return { ...partial, time: partial.time ?? "" };
}

function repo(label: string, threads: AiChatThread[], worktrees?: AiChatRepo[]): AiChatRepo {
  return { id: label, label, threads, worktrees };
}

function branch(state: NonNullable<AiChatThread["leaderBranch"]>["state"]): NonNullable<AiChatThread["leaderBranch"]> {
  return {
    id: "branch", parentEngine: "codex", parentSessionId: "parent", workspacePath: "/ws",
    engine: "codex", sessionId: null, title: "branch", task: "", model: null, effort: null,
    runId: null, state, createdAt: 1, updatedAt: 2, lastActivityAt: 2, deadlineAt: 90,
    expired: false, result: "", resultTruncated: false, error: null,
  };
}

it.each([false, true])("较旧的运行根任务优先于较新的闲置置顶任务（retrying=%s）", (retrying) => {
  const rows = recentThreadsByActivity([repo("ws", [
    thread({ id: "idle", label: "idle", updatedAt: 100, pinned: true }),
    thread({ id: "active", label: "active", updatedAt: 1, streaming: true, retrying }),
  ])]);
  expect(rows.map((row) => row.id)).toEqual(["active", "idle"]);
});

it.each(["starting", "running", "waiting", "awaiting_cost_approval"] as const)("%s 后代使整棵树优先，按树内最新时间排序且不重排子孙", (state) => {
  const grandchild = thread({ id: "grandchild", label: "grandchild", leaderBranch: branch(state) });
  const parent = thread({ id: "parent", label: "parent", updatedAt: 1, children: [
    thread({ id: "child", label: "child", children: [grandchild] }),
    thread({ id: "sibling", label: "sibling", updatedAt: 20 }),
  ] });
  const rows = recentThreadsByActivity([repo("ws", [
    thread({ id: "idle", label: "idle", updatedAt: 100 }),
    thread({ id: "active-root", label: "active-root", updatedAt: 10, streaming: true }),
    parent,
  ])]);
  expect(rows.map((row) => row.id)).toEqual(["parent", "active-root", "idle"]);
  expect(rows[0].children?.map((row) => row.id)).toEqual(["child", "sibling"]);
  expect(rows[0].children?.[0].children?.[0]).toMatchObject({ id: "grandchild", workspaceLabel: "ws" });
  expect(grandchild.workspaceLabel).toBeUndefined();
  expect(parent.children?.map((row) => row.id)).toEqual(["child", "sibling"]);
});

it.each([false, true])("运行后代结束后恢复时间顺序（有分支记录=%s）", (hasBranch) => {
  const child = thread({ id: "child", label: "child", updatedAt: 2, streaming: true,
    leaderBranch: hasBranch ? branch("running") : undefined });
  const repos = [repo("ws", [
    thread({ id: "idle", label: "idle", updatedAt: 100 }),
    thread({ id: "parent", label: "parent", updatedAt: 1, children: [child] }),
  ])];
  expect(recentThreadsByActivity(repos).map((row) => row.id)).toEqual(["parent", "idle"]);
  child.streaming = false;
  if (hasBranch) child.leaderBranch = branch("completed");
  expect(recentThreadsByActivity(repos).map((row) => row.id)).toEqual(["idle", "parent"]);
});

it("草稿优先于活动树，活动树同时间保持跨工作区遍历顺序", () => {
  const rows = recentThreadsByActivity([
    repo("ws", [
      thread({ id: "active-a", label: "a", updatedAt: 20, streaming: true }),
      thread({ id: "draft-parent", label: "parent", children: [thread({ label: "draft", isDraft: true })] }),
    ], [repo("wt", [thread({ id: "active-b", label: "b", updatedAt: 20, streaming: true })])]),
    repo("other", [thread({ id: "draft-root", label: "draft", isDraft: true }),
      thread({ id: "active-c", label: "c", updatedAt: 20, streaming: true })]),
  ]);
  expect(rows.map((row) => row.id)).toEqual(["draft-parent", "draft-root", "active-a", "active-b", "active-c"]);
});

it.each(["completed", "failed", "stopped", "handed_off", "unknown", "reclaiming", "reclaimed"] as const)("%s 分支不提升闲置树优先级", (state) => {
  const rows = recentThreadsByActivity([repo("ws", [
    thread({ id: "old", label: "old", leaderBranch: branch(state) }),
    thread({ id: "new", label: "new", updatedAt: 100 }),
  ])]);
  expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
});

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
          state: "completed",
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
