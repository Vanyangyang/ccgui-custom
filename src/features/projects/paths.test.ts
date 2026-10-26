import { describe, expect, it } from "vitest";
import { projectForPath, projectPathContains, projectRoots } from "./paths";
import type { WorkspaceProject } from "./types";
const project = (id: string, paths: string[]): WorkspaceProject => ({ id, name: id, defaultPath: paths[0], members: paths.map((path, i) => ({ id: `${i}`, path, label: path, role: "development", status: "available" })) });
describe("project paths", () => {
  it("matches Windows case and separators with segment boundaries", () => {
    expect(projectPathContains("G:\\Game\\", "g:/game/plan")).toBe(true);
    expect(projectPathContains("G:/game", "g:/games")).toBe(false);
    expect(projectPathContains("G:/game", "g:/game/../private")).toBe(false);
    expect(projectPathContains("/Game", "/game")).toBe(false);
  });
  it("deduplicates ancestor roots without collapsing siblings", () => {
    expect(projectRoots(project("p", ["G:/game/plan", "G:/game", "G:/research", "g:\\GAME"])).map((r) => r.path)).toEqual(["G:/game", "G:/research"]);
  });
  it("keeps an available child of an unavailable ancestor", () => {
    const p = project("p", ["G:/game", "G:/game/plan"]); p.members[0].status = "missing";
    expect(projectRoots(p)).toHaveLength(2);
    p.members[0].status = "available"; p.members[1].status = "changed";
    expect(projectRoots(p)).toHaveLength(2);
  });
  it("uses deepest coverage and refuses equal project ambiguity", () => {
    const a = project("a", ["G:/game"]), b = project("b", ["G:/game/plan"]), c = project("c", ["g:/game/plan"]);
    expect(projectForPath([a, b], "G:/game/plan/doc")).toBe(b);
    expect(projectForPath([a, b, c], "G:/game/plan/doc")).toBeNull();
    expect(projectForPath([a, b, c], "G:/game/plan/doc", "a")).toBe(a);
    expect(projectForPath([a, b], "G:/other", "a")).toBeNull();
  });
});
