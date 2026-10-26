import { describe, expect, it } from "vitest";
import type { LeaderBranch } from "@/features/leader/types";
import { isManagedCodexChild } from "./child-service-tier";

const branch = {
  engine: "codex", sessionId: "child", workspacePath: "G:/project", state: "running",
  parentEngine: "codex", parentSessionId: "parent",
} as LeaderBranch;

describe("managed Codex child service tier", () => {
  it.each(["codex", "claude", "cursor"])("recognizes children dispatched by %s", (parentEngine) => {
    expect(isManagedCodexChild([{ ...branch, parentEngine }], {
      engine: "codex", sessionId: "child", workspacePath: "G:\\project",
    })).toBe(true);
  });

  it("excludes parents, other workspaces, other engines, drafts and reclaimed branches", () => {
    const active = { engine: "codex", sessionId: "child", workspacePath: "G:/project" };
    expect(isManagedCodexChild([branch], { ...active, sessionId: "parent" })).toBe(false);
    expect(isManagedCodexChild([branch], { ...active, workspacePath: "G:/other" })).toBe(false);
    expect(isManagedCodexChild([branch], { ...active, engine: "claude" })).toBe(false);
    expect(isManagedCodexChild([{ ...branch, engine: "claude" }], { ...active, engine: "claude" })).toBe(false);
    expect(isManagedCodexChild([branch], { ...active, sessionId: null })).toBe(false);
    expect(isManagedCodexChild([branch], null)).toBe(false);
    expect(isManagedCodexChild([{ ...branch, state: "reclaimed" }], active)).toBe(false);
  });
});
