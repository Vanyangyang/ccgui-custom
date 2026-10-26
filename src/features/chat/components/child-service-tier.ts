import type { LeaderBranch } from "@/features/leader/types";
import { sameLeaderWorkspace } from "@/features/leader/workspace-path";

/** Managed Codex children always run at the standard tier, regardless of chat defaults. */
export function isManagedCodexChild(
  branches: readonly LeaderBranch[],
  active: { engine: string; sessionId: string | null; workspacePath: string } | null,
): boolean {
  return !!active?.sessionId && active.engine === "codex" && branches.some((branch) =>
    branch.state !== "reclaimed" && branch.engine === active.engine && branch.sessionId === active.sessionId
    && sameLeaderWorkspace(branch.workspacePath, active.workspacePath));
}
