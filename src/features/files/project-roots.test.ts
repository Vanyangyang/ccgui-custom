import { describe, expect, it, vi } from "vitest";
import { distinctProjectRoots, type FileProjectRoot } from "./project-roots";
import { resolveWorkspaceRepository } from "./repositorySelection";
import { matchProjectMentionEntries, type RootIndex } from "@/components/application/ai-chat/mention-files";
vi.mock("@/lib/ipc", () => ({ ipc: {} }));
const root = (path: string, status: FileProjectRoot["status"] = "available"): FileProjectRoot => ({ path, label: path.slice(1), role: "development", status });
const index = (): RootIndex => ({ status: "ready", fetchedAt: 1, entries: [{ rel: "README.md", name: "README.md", isDir: false, depth: 0, key: "readme.md", nameStart: 0 }] });
describe("project file roots", () => {
  it("deduplicates nested roots regardless of order", () => {
    expect(distinctProjectRoots([root("/game/plan"), root("/game"), root("/game/research"), root("/other")]).map((r) => r.path)).toEqual(["/game", "/other"]);
  });
  it("keeps same-name mentions distinguishable and anchored to their roots", () => {
    const matches = matchProjectMentionEntries([root("/game"), root("/plan")], { "/game": index(), "/plan": index() }, "readme");
    expect(matches.map((entry) => `${entry.root}/${entry.rel}`)).toEqual(["/game/README.md", "/plan/README.md"]);
    expect(matches.map((entry) => entry.rootLabel)).toEqual(["game", "plan"]);
  });
  it("does not duplicate nested indexes or use missing roots", () => {
    const matches = matchProjectMentionEntries([root("/game"), root("/game/plan"), root("/gone", "missing")], { "/game": index(), "/game/plan": index(), "/gone": index() }, "");
    expect(matches).toHaveLength(1);
    expect(matches[0].root).toBe("/game");
  });
  it("follows the other repository without permitting stale outside selection", () => {
    const input = { workspacePath: "/game", projectRoots: ["/game", "/plan"], repositoryRoots: ["/game", "/plan", "/plan/nested"] };
    expect(resolveWorkspaceRepository({ ...input, selectedPath: "/plan/nested/a.txt" })).toBe("/plan/nested");
    expect(resolveWorkspaceRepository({ ...input, selectedPath: "/plan/a.txt" })).toBe("/plan");
    expect(resolveWorkspaceRepository({ ...input, selectedPath: "/foreign/a.txt" })).toBe("/game");
  });
});
