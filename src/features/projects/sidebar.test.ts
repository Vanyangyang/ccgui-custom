import { describe, expect, it } from "vitest";
import type { AiChatRepo, AiChatRepoSection } from "@/components/application/ai-chat/sidebar-types";
import type { Workspace } from "@/lib/ipc";
import type { WorkspaceProject } from "./types";
import { organizeSidebarProjects, projectLaunchTarget, projectMemberRowId, projectRowId } from "./sidebar";

const project = (id: string, paths: string[]): WorkspaceProject => ({ id, name: `Project ${id}`, defaultPath: paths[0],
  members: paths.map((path, index) => ({ id: `m${index}`, path, label: `Custom ${index}`, role: "reference", status: "available" })) });
const workspace = (id: string, path: string) => ({ id, path, name: id } as Workspace);
const repo = (w: Workspace): AiChatRepo => ({ id: w.id, path: w.path, label: w.name,
  threads: [{ id: `codex/${w.id}`, workspacePath: w.path, label: w.name, time: "" }] });
const section = (repos: AiChatRepo[]): AiChatRepoSection[] => [{ id: null, name: "", repos }];

describe("projects in the ordinary workspace list", () => {
  it("groups related rows by custom names while retaining unrelated workspaces and exact chat ownership", () => {
    const workspaces = [workspace("game", "G:/game"), workspace("old", "G:/old"), workspace("other", "G:/other")];
    const repos = workspaces.map(repo);
    const p = project("p", ["g:\\game", "G:/old"]);
    const output = organizeSidebarProjects(section(repos), [p], workspaces, new Set(), {})!;
    expect(output.map((s) => s.id)).toEqual(["project:p", null]);
    expect(output[0].repos.map((r) => r.label)).toEqual(["Custom 0", "Custom 1"]);
    expect(output[0].repos[0].threads).toBe(repos[0].threads);
    expect(output[1].repos).toEqual([repos[2]]);
    expect(output.flatMap((s) => s.repos).flatMap((r) => r.threads)).toHaveLength(3);
    expect(workspaces.map((w) => w.path)).toEqual(["G:/game", "G:/old", "G:/other"]);
  });

  it("keeps nested shortcuts separate and does not move the parent chats into them", () => {
    const w = workspace("game", "G:/game");
    const p = project("p", ["G:/game", "G:/game/plan"]);
    const result = organizeSidebarProjects(section([repo(w)]), [p], [w], new Set(), {})![0];
    expect(result.repos[0].threads.map((t) => t.id)).toEqual(["codex/game"]);
    expect(result.repos[1]).toMatchObject({ id: projectMemberRowId("p", "m1"), directoryOnly: true, threads: [] });
    expect(projectLaunchTarget([p], result.repos[1].id!)?.path).toBe("G:/game/plan");
    expect(projectLaunchTarget([p], projectRowId("p"))?.path).toBe("G:/game");
  });

  it("never resurrects an archived root as a shortcut or enables its default launch", () => {
    const w = workspace("game", "G:/game");
    const p = project("p", ["G:/game", "G:/gone"]);
    p.members[1].status = "missing";
    const result = organizeSidebarProjects(section([]), [p], [w], new Set([w.id]), {})![0];
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]).toMatchObject({ unavailable: "missing", directoryOnly: true });
    expect(result.project?.canLaunch).toBe(false);
  });

  it("leaves shared roots ungrouped when project ownership is ambiguous, without duplicated chats", () => {
    const w = workspace("game", "/game"); const r = repo(w);
    const output = organizeSidebarProjects(section([r]), [project("a", ["/game"]), project("b", ["/game"])], [w], new Set(), {})!;
    expect(output[0].repos).toEqual([]);
    expect(output[1].repos).toEqual([]);
    expect(output[2].repos).toEqual([r]);
  });

  it("uses the project name consistently while preserving named groups, self-development rows and worktree trees", () => {
    const game = workspace("game", "/game"), other = workspace("other", "/other"), self = workspace("self", "/self");
    const gameRepo = { ...repo(game), worktrees: [repo(workspace("wt", "/game-wt"))] };
    const selfRepo = { ...repo(self), isSelfDev: true };
    const output = organizeSidebarProjects([{ id: null, name: "", repos: [gameRepo, selfRepo] }, { id: "group", name: "Personal", repos: [repo(other)] }],
      [project("p", ["/game", "/self"])], [game, other, self], new Set(), { game: "My name" })!;
    expect(output[0].repos[0].label).toBe("Custom 0");
    expect(output[0].repos[0].worktrees).toBe(gameRepo.worktrees);
    expect(output.find((s) => s.id === null)?.repos).toEqual([selfRepo]);
    expect(output.find((s) => s.id === "group")?.repos[0].id).toBe("other");
  });

  it("retains local workspace aliases for plugin-owned member names", () => {
    const w = workspace("game", "/game");
    const p = { ...project("plugin", ["/game"]), sourcePluginId: "test-plugin", sourceKey: "key" };
    const output = organizeSidebarProjects(section([repo(w)]), [p], [w], new Set(), { game: "Local override" })!;
    expect(output[0].repos[0].label).toBe("Local override");
  });

  it("keeps the original flat/grouped behavior when no projects exist", () => {
    expect(organizeSidebarProjects(section([]), [], [], new Set(), {})).toBeUndefined();
    const grouped = [{ id: "empty", name: "Empty", repos: [] }];
    expect(organizeSidebarProjects(grouped, [], [], new Set(), {})).toBe(grouped);
  });
});
