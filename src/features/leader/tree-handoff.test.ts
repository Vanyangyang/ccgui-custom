import { expect, it } from "vitest";
import { flattenLeaderThreads, groupLeaderThreads, threadContains } from "./tree";
import type { LeaderBranch, LeaderSnapshot } from "./types";

const branch = (id: string, next?: string): LeaderBranch => ({
  id, parentEngine: "codex", parentSessionId: "root", parentWorkspacePath: "G:/Plan", workspacePath: `G:/Tasks/${id}`,
  engine: "codex", sessionId: id, title: id, task: "", model: null, effort: null, runId: null,
  state: next ? "handed_off" : "running", createdAt: 1, updatedAt: 1, lastActivityAt: 1, deadlineAt: 2,
  expired: false, result: "", resultTruncated: false, error: null,
  ...(next ? { handoffTo: { branchId: next, requestId: id, operationId: id, payloadFingerprint: id } } : {}),
});

it("groups retired handoff branches under history without changing successor ancestry or tracking", () => {
  const snapshot: LeaderSnapshot = { leaders: [], branches: [branch("A", "B"), branch("B", "C"), branch("C")] };
  const [root] = groupLeaderThreads([], snapshot, "g:\\Plan\\");
  expect(root.children?.filter((row) => !row.handoffHistory).map((row) => row.id)).toEqual(["codex/C"]);
  const history = root.children?.find((row) => row.handoffHistory);
  expect(history?.children?.map((row) => row.id)).toEqual(["codex/A", "codex/B"]);
  expect(flattenLeaderThreads([root]).map((row) => row.id)).toEqual(["codex/root", "codex/C", "codex/A", "codex/B"]);
  expect(threadContains(root, "codex/A")).toBe(true);
  expect(threadContains(root, "codex/C")).toBe(true);
  expect(history?.children?.[0].leaderBranch?.handoffTo?.branchId).toBe("B");
  expect(history?.children?.[1].leaderBranch?.handoffTo?.branchId).toBe("C");
  expect(history?.children?.[0]).toMatchObject({ workspacePath: "G:/Tasks/A", protectedFromDeletion: true, selectable: true });
  expect(snapshot.branches.map((row) => row.state)).toEqual(["handed_off", "handed_off", "running"]);
});

it("does not retire an incomplete handoff and hides the whole archived group", () => {
  const incomplete = { ...branch("A"), state: "handed_off" as const };
  const snapshot: LeaderSnapshot = { leaders: [], branches: [incomplete] };
  expect(groupLeaderThreads([], snapshot, "G:/Plan")[0].children?.[0].id).toBe("codex/A");
  snapshot.archivedGroups = [{ title: "root", root: { engine: "codex", sessionId: "root", workspacePath: "G:/Plan" }, members: [{ engine: "codex", sessionId: "A", workspacePath: "G:/Tasks/A" }], branchIds: ["A"], archivedAt: 1 }];
  expect(groupLeaderThreads([], snapshot, "G:/Plan")).toEqual([]);
});
