import { describe, expect, it } from "vitest";
import { flattenLeaderThreads, groupLeaderThreads, parentOfBranch } from "./tree";
import type { LeaderBranch, LeaderSnapshot } from "./types";
import type { AiChatThread } from "@/components/application/ai-chat/sidebar-types";

const branch = (id: string, parentSessionId: string, parent: string, child: string): LeaderBranch => ({
  id, parentEngine: "codex", parentSessionId, parentWorkspacePath: parent, workspacePath: child,
  engine: "codex", sessionId: id, title: id, task: "", model: "gpt-6-astra", effort: "medium", runId: null,
  state: "completed", createdAt: 1, updatedAt: 1, lastActivityAt: 1, deadlineAt: 2, expired: false,
  result: "", resultTruncated: false, error: null,
});
const row = (id: string, workspacePath: string) => ({ id: `codex/${id}`, label: id, engine: "codex", workspacePath, time: "" });

describe("cross-workspace native task groups", () => {
  it("keeps the full group under the parent while selecting each actual child cwd", () => {
    const child = branch("child", "root", "G:/plan", "G:/game");
    const grandchild = branch("grandchild", "child", "G:/game", "G:/assets");
    const snapshot: LeaderSnapshot = { leaders: [], branches: [child, grandchild] };
    const roots = groupLeaderThreads([row("root", "G:/plan")], snapshot, "G:/plan");
    expect(roots).toHaveLength(1);
    expect(flattenLeaderThreads(roots).map((item) => [item.id, item.workspacePath])).toEqual([
      ["codex/root", "G:/plan"], ["codex/child", "G:/game"], ["codex/grandchild", "G:/assets"],
    ]);
    expect(parentOfBranch(child).workspacePath).toBe("G:/plan");
    expect(parentOfBranch(grandchild).workspacePath).toBe("G:/game");
    expect(groupLeaderThreads([row("child", "G:/game"), row("ordinary", "G:/game")], snapshot, "G:/game").map((item) => item.id)).toEqual(["codex/ordinary"]);
  });

  it("uses the parent source for fallback rows and preserves legacy records", () => {
    const child = branch("child", "root", "G:/plan", "G:/game");
    const snapshot: LeaderSnapshot = { leaders: [], branches: [child] };
    expect(groupLeaderThreads([], snapshot, "G:/plan")[0]).toMatchObject({ workspacePath: "G:/plan", leaderParentFallback: true });
    const { parentWorkspacePath: _parent, ...legacy } = child;
    expect(parentOfBranch(legacy).workspacePath).toBe("G:/game");
    expect(groupLeaderThreads([], { leaders: [], branches: [legacy] }, "G:/game")[0].workspacePath).toBe("G:/game");
  });

  it("matches a root without an override across drive-case and trailing-slash aliases", () => {
    const snapshot: LeaderSnapshot = { leaders: [], branches: [branch("child", "root", "g:\\plan", "G:/game")] };
    const roots = groupLeaderThreads([row("root", "g:\\plan")], snapshot, "G:/plan/");
    expect(roots).toHaveLength(1);
    expect(roots[0].workspacePath).toBe("g:\\plan");
    expect(roots[0].children?.[0].id).toBe("codex/child");
  });

  it("moves the complete tree to the root sidebar assignment without changing execution paths", () => {
    const snapshot: LeaderSnapshot = { leaders: [], branches: [branch("child", "root", "G:/plan", "G:/game"), branch("grandchild", "child", "G:/game", "G:/assets")] };
    const all: AiChatThread[] = [
      { ...row("root", "G:/plan"), sidebarWorkspacePath: "g:\\sorted\\" },
      { ...row("child", "G:/game"), label: "Custom child", streaming: true, sidebarWorkspacePath: "G:/ignored" },
      row("grandchild", "G:/assets"),
    ];
    const result = groupLeaderThreads([all[0]], snapshot, "G:/sorted", all);
    expect(flattenLeaderThreads(result).map((item) => [item.id, item.workspacePath])).toEqual([
      ["codex/root", "G:/plan"], ["codex/child", "G:/game"], ["codex/grandchild", "G:/assets"],
    ]);
    expect(result[0].children?.[0]).toMatchObject({ label: "Custom child", streaming: true });
    for (const path of ["G:/plan", "G:/game", "G:/assets", "G:/ignored"]) {
      expect(groupLeaderThreads(all.filter((item) => (item.sidebarWorkspacePath ?? item.workspacePath) === path), snapshot, path, all)).toEqual([]);
    }
    expect(all[0]).not.toHaveProperty("children");
    expect(all[1]).not.toHaveProperty("children");
  });

  it("hides archived cross-project children in their original workspace too", () => {
    const child = branch("child", "root", "G:/plan", "G:/game");
    const snapshot: LeaderSnapshot = { leaders: [], branches: [child], archivedGroups: [{ title: "game goal", root: { engine: "codex", sessionId: "root", workspacePath: "G:/plan" }, members: [{ engine: "codex", sessionId: "child", workspacePath: "G:/game" }], branchIds: ["child"], archivedAt: 1 }] };
    expect(groupLeaderThreads([row("child", "G:/game")], snapshot, "G:/game")).toEqual([]);
  });
});
