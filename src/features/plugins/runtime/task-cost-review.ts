import type { HostTaskCostApproval, HostTaskSelection } from "@ccgui/plugin-sdk";
import { approveCrossSessionMessage, cancelCrossSessionMessage, crossSessionParticipantKey, useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "@/features/chat/cross-session";
import { canPrepareCrossSessionHandoff, prepareCrossSessionHandoff } from "@/features/chat/cross-session-handoff";
import { handoffLeaderCostApproval, resolveLeaderCostApproval } from "@/features/leader/cost-approval";
import type { TaskSessionRef } from "./task-facade";
import { ipc } from "@/lib/ipc";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { latestMessageUsage } from "@/features/chat/usage";
import { crossSessionCostReview, hasConflictingSessionCostTab, sameSessionCostWorkspace, type CrossSessionCostReview } from "@/features/chat/cross-session-cost";
import type { ChatStore } from "@/features/chat/store/types";
import { getSessionCacheHeat, usesUnlimitedPromptCache } from "@/features/chat/prompt-cache";
import { taskCostCacheReference, taskCostContextProjection, taskCostTelemetrySignature, taskPendingCostEstimate } from "./task-cost-telemetry";

const LIMIT = 32;
const clip = (text: string) => Array.from(text).slice(0, 1200).join("");
const decisionId = (record: CrossSessionCommunicationRecord) => record.leaderCostApproval?.requestId ?? record.requestId;
const participant = (value: CrossSessionCommunicationRecord["sender"]) => ({ engine: value.engine, sessionId: value.sessionId, workspacePath: value.workspacePath, ...(value.title ? { title: value.title } : {}) });
const imageRefs = (record: CrossSessionCommunicationRecord): string[] => {
  const refs = record.leaderCostApproval ? record.imageRefs ?? [] : [];
  if (refs.some(ref => !/^task-image:[a-f0-9]{64}$/.test(ref))) throw new Error("Invalid task image reference");
  const copy = [...refs]; Object.freeze(copy); return copy;
};

/** Stable local history-source version, not a request identity or transcript
 * hash. Unrelated chats, display labels and live message deltas cannot retry a
 * failed read. Same-id ambiguity is included because native lookup omits cwd. */
export function taskCostContextVersion(target: TaskSessionRef, state = useChatStore.getState()): string {
  const candidates = state.sessions.filter(meta => meta.engine === target.engine && meta.sessionId === target.sessionId);
  const exact = candidates.filter(meta => sameSessionCostWorkspace(meta.workspacePath, target.workspacePath));
  return JSON.stringify([
    !!state.archivedSessionKeys[sessionKey(target.engine, target.sessionId, target.workspacePath)],
    candidates.length === 1,
    hasConflictingSessionCostTab(target, state.openTabs),
    exact.map(meta => JSON.stringify([meta.filePath, meta.fileSize, meta.fileMtimeMs, meta.updatedAt,
      meta.messageCount, meta.model ?? null, !!meta.remote])).sort(),
  ]);
}

function targetMeta(record: CrossSessionCommunicationRecord, state: ChatStore) {
  const target = record.target;
  if (!target.sessionId || !target.workspacePath) return undefined;
  const candidates = state.sessions.filter(meta => meta.engine === target.engine && meta.sessionId === target.sessionId);
  // Native history lookup has no workspace argument: ambiguous identities must
  // never fall through to a transcript belonging to another workspace.
  if (candidates.length !== 1 || hasConflictingSessionCostTab(target, state.openTabs)) return undefined;
  const meta = candidates[0];
  return !meta.remote && sameSessionCostWorkspace(meta.workspacePath, target.workspacePath) &&
    !state.archivedSessionKeys[sessionKey(target.engine, target.sessionId, target.workspacePath)] ? meta : undefined;
}

function sampleReview(record: CrossSessionCommunicationRecord, state: ChatStore): CrossSessionCostReview | undefined {
  const meta = targetMeta(record, state);
  const target = record.target;
  const session = state.bySession[sessionKey(target.engine, target.sessionId, target.workspacePath)];
  if (!meta || !session) {
    if (!record.costReview) return undefined;
    const model = record.leaderCostApproval ? record.leaderCostApproval.model ?? undefined : record.costReview.model;
    return { ...record.costReview, model, cacheHeat: record.costReview.cache ? getSessionCacheHeat(record.costReview.cache) : record.costReview.cacheHeat, cacheExpiryDisabled: usesUnlimitedPromptCache(target.engine, model) };
  }
  const awaiting = session.messages.some(message => message.question?.status === "pending" || message.grant?.status === "pending" ||
    ["awaiting_review", "deferred", "submitting"].includes(message.planReview?.status ?? ""));
  const sample = crossSessionCostReview({ ...meta, workspacePath: target.workspacePath }, state,
    awaiting ? "awaiting_permission" : session.streaming || session.queue.length ? "busy" : "idle", Date.now(),
    record.leaderCostApproval ? record.leaderCostApproval.model ?? null : undefined);
  // The native approval's cache evidence is held at creation, not resampled.
  return record.leaderCostApproval && record.costReview ? { ...record.costReview,
    model: sample.model, context: sample.context, targetStatus: sample.targetStatus, capturedAt: sample.capturedAt,
    cacheHeat: record.costReview.cache ? getSessionCacheHeat(record.costReview.cache) : record.costReview.cacheHeat, cacheExpiryDisabled: sample.cacheExpiryDisabled } : sample;
}

export function projectTaskCostApprovals(refs: TaskSessionRef[], records = useCrossSessionActivityStore.getState().records): { items: HostTaskCostApproval[]; truncated: boolean } {
  const allowed = new Set(refs.map(crossSessionParticipantKey));
  // The sender must be the owned coordinator or its proven descendant. A
  // shared target alone does not make another conversation's request ours.
  const matches = records.filter(record => record.status === "awaiting_cost_approval" && allowed.has(crossSessionParticipantKey(record.sender)));
  return { truncated: matches.length > LIMIT, items: matches.slice(0, LIMIT).map(record => {
    const review = sampleReview(record, useChatStore.getState()), message = clip(record.message);
    const reference = taskCostCacheReference(review);
    const approval: HostTaskCostApproval = { kind: record.leaderCostApproval ? "leader" : "crossSession", id: record.scopedId, requestId: decisionId(record), sender: participant(record.sender), target: participant(record.target),
      message, truncated: Array.from(record.message).length > Array.from(message).length,
      ...(record.leaderCostApproval ? { imageRefs: imageRefs(record) } : {}),
      model: record.leaderCostApproval?.model ?? review?.model ?? null, cacheHeat: review?.cacheHeat ?? "unknown",
      ...taskCostContextProjection(review), ...(reference ? { cacheReference: reference } : {}),
      capturedAt: record.costReview?.capturedAt ?? record.acceptedAt,
      canHandoff: canPrepareCrossSessionHandoff(record, review),
    };
    return { ...approval, requestEstimate: taskPendingCostEstimate(approval, record.message, record.leaderCostApproval ? imageRefs(record).length : undefined) };
  }) };
}

/** Compare only pending records and avoid serializing full message bodies. */
export function taskCostApprovalsChanged(next: CrossSessionCommunicationRecord[], previous: CrossSessionCommunicationRecord[]): boolean {
  const a = next.filter(record => record.status === "awaiting_cost_approval");
  const b = previous.filter(record => record.status === "awaiting_cost_approval");
  return a.length !== b.length || a.some((item, index) => {
    const old = b[index];
    return item.scopedId !== old.scopedId || item.requestId !== old.requestId || item.message !== old.message ||
      JSON.stringify(item.imageRefs ?? []) !== JSON.stringify(old.imageRefs ?? []) ||
      crossSessionParticipantKey(item.sender) !== crossSessionParticipantKey(old.sender) || crossSessionParticipantKey(item.target) !== crossSessionParticipantKey(old.target) ||
      item.sender.title !== old.sender.title || item.target.title !== old.target.title ||
      JSON.stringify(item.costReview) !== JSON.stringify(old.costReview) || JSON.stringify(item.leaderCostApproval) !== JSON.stringify(old.leaderCostApproval);
  });
}

const sameIdentity = (a: HostTaskCostApproval, b: HostTaskCostApproval) => a.kind === b.kind && a.id === b.id && a.requestId === b.requestId && a.model === b.model && a.message === b.message && a.truncated === b.truncated &&
  JSON.stringify(a.imageRefs ?? []) === JSON.stringify(b.imageRefs ?? []) &&
  crossSessionParticipantKey(a.sender) === crossSessionParticipantKey(b.sender) && crossSessionParticipantKey(a.target) === crossSessionParticipantKey(b.target);

function readTaskCostApproval(refs: TaskSessionRef[], expected: HostTaskCostApproval) {
  const records = useCrossSessionActivityStore.getState().records;
  const current = projectTaskCostApprovals(refs, records).items.find(item => item.id === expected.id);
  const record = records.find(item => item.scopedId === expected.id);
  if (!current || !record || record.status !== "awaiting_cost_approval" || !sameIdentity(current, expected)) throw new Error("Cost review changed; refresh before deciding");
  return { current, record };
}

/** Read recent native history into a temporary snapshot; never activate or mutate a session. */
export async function loadTaskCostContext(refs: TaskSessionRef[], expected: HostTaskCostApproval): Promise<HostTaskCostApproval | null> {
  const { record } = readTaskCostApproval(refs, expected);
  const state = useChatStore.getState(), meta = targetMeta(record, state);
  if (!meta) return null;
  const stamp = taskCostContextVersion(record.target, state), heldStamp = JSON.stringify(record);
  const page = await ipc.loadSessionPage(meta.engine, meta.sessionId, 100);
  const latest = readTaskCostApproval(refs, expected);
  const currentState = useChatStore.getState(), currentMeta = targetMeta(latest.record, currentState);
  if (!currentMeta || taskCostContextVersion(latest.record.target, currentState) !== stamp || JSON.stringify(latest.record) !== heldStamp) return null;
  const usage = latestMessageUsage(page.messages);
  if (usage == null) return null;
  const key = sessionKey(meta.engine, meta.sessionId, record.target.workspacePath);
  const temporary: ChatStore = { ...currentState, bySession: { ...currentState.bySession,
    [key]: { ...EMPTY_SESSION, messages: page.messages, usage } } };
  const review = sampleReview(record, temporary);
  // Keep the request/cache snapshot and its sampling timestamp intact; only
  // context telemetry is enriched by this asynchronous history read.
  const { used: _used, max: _max, contextReference: _reference, modelMismatch: _mismatch, usageModel: _model, ...base } = expected;
  const enriched = { ...base, ...taskCostContextProjection(review) };
  return { ...enriched, requestEstimate: taskPendingCostEstimate(enriched, record.message, record.leaderCostApproval ? imageRefs(record).length : undefined) };
}

/** Host-only, in-memory snapshot. Keep the full message out of projections and logs. */
export function captureTaskCostApproval(refs: TaskSessionRef[], expected: HostTaskCostApproval): { approval: HostTaskCostApproval; message: string; imageRefs: string[]; kind: "leader" | "cross-session" } {
  const { current, record } = readTaskCostApproval(refs, expected);
  return { approval: current, message: record.message, imageRefs: imageRefs(record), kind: record.leaderCostApproval ? "leader" : "cross-session" };
}

/** Called only after the native dialog confirmed a human decision. Re-read the
 * held request and ownership rather than trusting the displayed projection. */
export async function resolveTaskCostApproval(refs: TaskSessionRef[], expected: HostTaskCostApproval, decision: "approve" | "cancel" | "handoff", expectedMessage?: string): Promise<void> {
  const { current, record } = readTaskCostApproval(refs, expected);
  if (expectedMessage !== undefined && record.message !== expectedMessage) throw new Error("Cost review changed; refresh before deciding");
  if (decision === "approve" && taskCostTelemetrySignature(current) !== taskCostTelemetrySignature(expected)) {
    // An unopened target may have read-only context added by the bridge. Re-read
    // that exact source instead of accepting either missing or stale evidence.
    const refreshed = current.used === undefined && expected.used !== undefined ? await loadTaskCostContext(refs, current) : null;
    if (!refreshed || taskCostTelemetrySignature(refreshed) !== taskCostTelemetrySignature(expected)) throw new Error("Cost evidence changed; refresh before deciding");
    const latest = readTaskCostApproval(refs, expected);
    if (latest.record.message !== record.message) throw new Error("Cost review changed; refresh before deciding");
  }
  if (decision === "handoff") { prepareCrossSessionHandoff(record); return; }
  if (record.leaderCostApproval) await resolveLeaderCostApproval(record, decision === "approve");
  else if (decision === "approve") await approveCrossSessionMessage(record.scopedId, undefined, current.model);
  else await cancelCrossSessionMessage(record.scopedId);
}

/** Host-only execution after native human confirmation and source-stamp checks.
 * Re-read the full ledger message; the public bounded projection is not proof. */
export async function handoffTaskCostApproval(refs: TaskSessionRef[], expected: HostTaskCostApproval, expectedMessage: string, summary: string, operationId: string, targetSelection?: HostTaskSelection): Promise<void> {
  const { record } = readTaskCostApproval(refs, expected);
  if (expected.kind !== "leader" || !record.leaderCostApproval || expected.id !== `leader:${record.leaderCostApproval.branchId}` || record.message !== expectedMessage) throw new Error("Managed child cost review changed before handoff");
  await handoffLeaderCostApproval(record, summary, operationId, targetSelection);
}
