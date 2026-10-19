import { describe, expect, it } from "vitest";
import { leaderWorkspacePathKey, sameLeaderWorkspace } from "./workspace-path";
import { isDirectChild, leaderGroupBranches, leaderGroupRoot, sameIdentity, type LeaderBranch } from "./types";
import { groupLeaderThreads } from "./tree";

describe("Leader workspace path identity", () => {
  it.each([
    ["G:\\Projects\\ccgui-custom", "G:/Projects/ccgui-custom"],
    ["G:\\", "G:/"],
    [String.raw`G:\\Projects\\ccgui-custom`, "G:/Projects/ccgui-custom"],
    ["G://Projects///ccgui-custom", "G:/Projects/ccgui-custom"],
    [String.raw`G:\/Projects/\ccgui-custom`, "G:/Projects/ccgui-custom"],
    ["G:////", "G:/"],
  ])("recognizes Windows separators in %s", (a, b) => {
    expect(sameLeaderWorkspace(a, b)).toBe(true);
  });

  it.each([
    ["G:/project", "G:/other"], ["G:/project", "G:/project/child"],
    ["G:/project", "g:/project"], ["G:/project", "G:/PROJECT"],
    ["G:/project", "G:/other/../project"], ["G:/", "G:"],
    ["G:/project", "G:/project/"], ["\\\\server\\share", "//server/share"],
    ["/project/name", "/project\\name"], ["project/name", "project\\name"],
    ["/project", "/project/child"],
    ["/project/name", "/project//name"], ["/project", "/PROJECT"],
    ["//server/share", "/server/share"],
    [String.raw`\\server\share`, String.raw`\\server\\share`],
    ["ssh://host/project", "ssh:/host/project"],
    [String.raw`G:project\\name`, String.raw`G:project\name`],
  ])("keeps distinct directories isolated: %s vs %s", (a, b) => {
    expect(sameLeaderWorkspace(a, b)).toBe(false);
  });

  it("preserves POSIX paths and Windows root separators", () => {
    expect(leaderWorkspacePathKey("/project\\name/")).toBe("/project\\name/");
    expect(leaderWorkspacePathKey("G:\\")).toBe("G:/");
  });

  it("resolves ancestry and tree ownership across separator variants only", () => {
    const root = { engine: "claude", sessionId: "root", workspacePath: "G:/project" };
    const child = { id: "child", engine: "codex", sessionId: "child", parentEngine: "claude", parentSessionId: "root", workspacePath: "G:\\project", state: "running", title: "task" } as LeaderBranch;
    const snapshot = { leaders: [{ ...root, workspacePath: "G:\\project" }], branches: [child] };
    expect(sameIdentity(root, snapshot.leaders[0])).toBe(true);
    expect(isDirectChild(child, root)).toBe(true);
    expect(leaderGroupBranches(snapshot, root)).toEqual([child]);
    expect(sameIdentity(leaderGroupRoot(snapshot, { ...root, engine: "codex", sessionId: "child" }), root)).toBe(true);
    const rows = [{ id: "claude/root", label: "root", time: "" }];
    expect(groupLeaderThreads(rows, snapshot, root.workspacePath)[0]).toMatchObject({ isLeader: true, children: [{ id: "codex/child" }] });
    for (const path of ["G:/project/child", "G:/other", "/project\\name"]) {
      expect(isDirectChild(child, { ...root, workspacePath: path })).toBe(false);
      expect(groupLeaderThreads(rows, snapshot, path)).toEqual(rows);
    }
    expect(groupLeaderThreads(rows, { ...snapshot, archivedGroups: [{ root: snapshot.leaders[0], title: "root", archivedAt: 1, members: [], branchIds: [child.id] }] }, root.workspacePath)).toEqual([]);
  });
});
