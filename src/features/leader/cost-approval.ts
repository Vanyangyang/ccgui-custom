import { invoke } from "@/lib/transport";
import type { CrossSessionCommunicationRecord } from "@/features/chat/cross-session";
import { useLeaderStore } from "./store";
import type { LeaderSnapshot } from "./types";

const pending = new Map<string, Promise<void>>();

/** Human-only resolution; the native request identity is never reconstructed
 * from the current branch, so a stale card cannot approve a replacement task. */
export function resolveLeaderCostApproval(record: CrossSessionCommunicationRecord, approve: boolean): Promise<void> {
  const approval = record.leaderCostApproval;
  if (!approval) return Promise.reject(new Error("Missing task cost approval identity"));
  const key = JSON.stringify([approval.branchId, approval.requestId]);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = (async () => {
    try {
      await invoke<LeaderSnapshot>("task_resolve_cost_approval", {
        parentEngine: record.sender.engine, parentSessionId: record.sender.sessionId,
        workspacePath: record.sender.workspacePath, branchId: approval.branchId,
        requestId: approval.requestId, approve, reviewedModel: approval.model ?? null,
      });
    } finally {
      // Do not install a command response over newer native event state.
      await useLeaderStore.getState().refresh();
    }
  })().finally(() => { pending.delete(key); });
  pending.set(key, request);
  return request;
}
