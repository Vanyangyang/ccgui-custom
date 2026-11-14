import { invoke } from "@/lib/transport";
import { crossSessionParticipantKey, useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "@/features/chat/cross-session";
import { useLeaderStore } from "./store";
import type { LeaderSnapshot } from "./types";
import type { HostTaskSelection } from "@ccgui/plugin-sdk";
import i18n from "@/lib/i18n";

const TARGET_ERROR_KEYS = {
  HANDOFF_TARGET_INVALID: "crossSession.managedHandoffTargetInvalid",
  HANDOFF_TARGET_UNAVAILABLE: "crossSession.managedHandoffTargetUnavailable",
  HANDOFF_TARGET_RESOLUTION_FAILED: "crossSession.managedHandoffTargetResolutionFailed",
  HANDOFF_TARGET_NOT_ALLOWED: "crossSession.managedHandoffTargetNotAllowed",
  HANDOFF_TARGET_CHANGED: "crossSession.managedHandoffTargetChanged",
} as const;
type HandoffTargetErrorCode = keyof typeof TARGET_ERROR_KEYS;

/** Only fixed host-authored classifications may reach the handoff error UI. */
export class HandoffTargetSelectionError extends Error {
  constructor(readonly code: HandoffTargetErrorCode) { super(i18n.t(TARGET_ERROR_KEYS[code])); }
}

function targetResolutionError(cause: unknown): HandoffTargetSelectionError {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const code = (Object.keys(TARGET_ERROR_KEYS) as HandoffTargetErrorCode[]).find(value => message.startsWith(value));
  return new HandoffTargetSelectionError(code ?? "HANDOFF_TARGET_RESOLUTION_FAILED");
}

export function isHandoffTargetSelection(value: unknown): value is HostTaskSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as HostTaskSelection;
  const selector = (text: unknown): text is string => typeof text === "string" && !!text.trim() && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text);
  return Object.keys(value).every(key => ["engine", "model", "providerId", "effort"].includes(key)) &&
    selector(selection.model) && selector(selection.providerId) &&
    (selection.engine === "agy" ? selection.effort === undefined : ["claude", "codex"].includes(selection.engine) &&
      ["low", "medium", "high", "xhigh", "max", "ultra"].includes(selection.effort ?? ""));
}

/** Read-only native resolution; never changes the current chat or its defaults. */
export async function resolveHandoffTargetSelection(selection: HostTaskSelection): Promise<HostTaskSelection> {
  if (!isHandoffTargetSelection(selection)) throw new HandoffTargetSelectionError("HANDOFF_TARGET_INVALID");
  const requested = { ...selection };
  let resolved: HostTaskSelection;
  try { resolved = await invoke<HostTaskSelection>("task_resolve_handoff_selection", { selection: requested }); }
  catch (cause) { throw targetResolutionError(cause); }
  if (!isHandoffTargetSelection(resolved) || resolved.engine !== requested.engine || resolved.providerId !== requested.providerId) {
    throw new HandoffTargetSelectionError("HANDOFF_TARGET_INVALID");
  }
  return { ...resolved };
}

const pending = new Map<string, { decision: string; promise: Promise<void> }>();

function exclusive(key: string, decision: string, action: () => Promise<void>): Promise<void> {
  const existing = pending.get(key);
  if (existing) return existing.decision === decision ? existing.promise : Promise.reject(new Error("Another decision for this task is in progress"));
  const promise = action().finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
  pending.set(key, { decision, promise });
  return promise;
}

/** Human-only resolution; the native request identity is never reconstructed
 * from the current branch, so a stale card cannot approve a replacement task. */
export function resolveLeaderCostApproval(record: CrossSessionCommunicationRecord, approve: boolean): Promise<void> {
  const approval = record.leaderCostApproval;
  if (!approval) return Promise.reject(new Error("Missing task cost approval identity"));
  const key = JSON.stringify([approval.branchId, approval.requestId]);
  return exclusive(key, approve ? "approve" : "cancel", async () => {
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
  });
}

/** An explicit human action. The native ledger revalidates and reserves the
 * replacement before any model launch; an uncertain retry keeps the same id. */
export function handoffLeaderCostApproval(record: CrossSessionCommunicationRecord, summary: string, operationId: string, targetSelection?: HostTaskSelection): Promise<void> {
  const approval = record.leaderCostApproval;
  if (!approval || !record.target.sessionId || record.target.sessionId.startsWith("leader-branch:")) return Promise.reject(new Error("Missing managed child identity"));
  if (!summary.trim() || summary.length > 8000 || summary.includes("\0") || !operationId || operationId.length > 128) return Promise.reject(new Error("Invalid handoff summary or operation identity"));
  if (targetSelection !== undefined && !isHandoffTargetSelection(targetSelection)) return Promise.reject(new Error("Invalid handoff target selection"));
  const target = targetSelection && { ...targetSelection };
  const current = useCrossSessionActivityStore.getState().records.find(item => item.scopedId === record.scopedId);
  if (!current || current.status !== "awaiting_cost_approval" || current.leaderCostApproval?.branchId !== approval.branchId ||
    current.leaderCostApproval?.requestId !== approval.requestId || current.leaderCostApproval?.model !== approval.model ||
    current.message !== record.message || crossSessionParticipantKey(current.sender) !== crossSessionParticipantKey(record.sender) ||
    crossSessionParticipantKey(current.target) !== crossSessionParticipantKey(record.target) ||
    JSON.stringify(current.imageRefs ?? []) !== JSON.stringify(record.imageRefs ?? [])) return Promise.reject(new Error("Cost review changed; refresh before handing off"));
  const key = JSON.stringify([approval.branchId, approval.requestId]);
  return exclusive(key, JSON.stringify(["handoff", operationId, summary, ...(target ? [target] : [])]), async () => {
    try {
      await invoke<LeaderSnapshot>("task_handoff_child", {
        parentEngine: record.sender.engine, parentSessionId: record.sender.sessionId,
        workspacePath: record.sender.workspacePath, branchId: approval.branchId, requestId: approval.requestId,
        sourceSessionId: record.target.sessionId, reviewedModel: approval.model ?? null, operationId, summary,
        ...(target ? { targetSelection: target } : {}),
      });
    } finally {
      await useLeaderStore.getState().refresh();
    }
  });
}
