import type { AiChatRepo, AiChatThread } from "@/components/application/ai-chat/sidebar-types";

export interface RecentThread extends AiChatThread {
  treeWorkspaceKey?: string;
  /** Display grouping only; execution keeps each thread's workspacePath. */
  workspace?: Pick<AiChatRepo, "label" | "path">;
}

/** Keep disclosure identities identical when switching sidebar views. */
export function threadTreeWorkspaceKey(thread: AiChatThread, roots: AiChatThread[]): string {
  return thread.leaderBranch?.workspacePath ?? roots.find((row) => row.children?.length)?.children?.[0]?.leaderBranch?.workspacePath ?? "";
}

/** 【全部会话】一条对话的排序时间：草稿排在最前；
 *  有会话时间戳用会话时间，否则用 Leader 分支的最后活动时间。 */
function activityAt(thread: AiChatThread): number {
  if (thread.isDraft) return Number.POSITIVE_INFINITY;
  if (typeof thread.updatedAt === "number" && thread.updatedAt > 0) return thread.updatedAt;
  const branch = thread.leaderBranch;
  if (branch) return branch.lastActivityAt || branch.updatedAt || 0;
  return 0;
}

function treeActivityAt(thread: AiChatThread): number {
  return (thread.children ?? []).reduce((latest, child) => Math.max(latest, treeActivityAt(child)), activityAt(thread));
}

function treePriority(thread: AiChatThread): number {
  const state = thread.leaderBranch?.state;
  const active = thread.streaming || state === "starting" || state === "running"
    || state === "waiting" || state === "awaiting_cost_approval";
  const priority = thread.isDraft ? 2 : active ? 1 : 0;
  return (thread.children ?? []).reduce((highest, child) => Math.max(highest, treePriority(child)), priority);
}

function withWorkspaceLabel(thread: AiChatThread, label: string): AiChatThread {
  return { ...thread, workspaceLabel: label, children: thread.children?.map((child) => withWorkspaceLabel(child, label)) };
}

/** 聚合各工作区（含 worktree）的根任务：草稿树、进行中树、闲置树依次排列，
 *  同一优先级按整棵树的最新活动时间排列。
 *  置顶只保留图标，不改变这次排序；同一时间保持原有遍历顺序。 */
export function recentThreadsByActivity(repos: AiChatRepo[]): RecentThread[] {
  const rows: RecentThread[] = [];
  const visit = (repo: AiChatRepo) => {
    for (const thread of repo.threads) {
      rows.push({ ...withWorkspaceLabel(thread, repo.label), workspace: { label: repo.label, path: repo.path }, treeWorkspaceKey: threadTreeWorkspaceKey(thread, repo.threads) });
    }
    for (const child of repo.worktrees ?? []) visit(child);
  };
  for (const repo of repos) visit(repo);
  return rows
    .map((thread, index) => ({ thread, index, priority: treePriority(thread), activity: treeActivityAt(thread) }))
    .sort((a, b) => b.priority - a.priority || b.activity - a.activity || a.index - b.index)
    .map(({ thread }) => thread);
}
