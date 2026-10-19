import type {
  Message,
  PlanReview,
  PlanReviewStatus,
} from "@/lib/ipc";
import type { ChatStore } from "./types";

/**
 * Plan preview & approval cards (P2 unified UI): the backend emits typed
 * plan events (plan_draft / plan_review / plan_review_settled) and owns the
 * approval fact source (plan_review table + CAS). The store keeps one
 * timeline row per planId+revision so history stays reviewable after the
 * run ends; the dock acts only on the latest actionable record.
 *
 * A decision submit is planId + expectedRevision + decision + optional
 * feedback — native RPC methods, paths and approval tokens never leave the
 * backend, so the record carries no reply context the UI could misuse.
 */

declare module "@/lib/ipc" {
  interface Message {
    /** Plan-approval card state (role "plan_review"): keyed by
     *  planId+revision. Ephemeral UI — not part of the CLI transcript. */
    planReview?: PlanReview;
  }
}

/** Timeline role for plan cards. */
export const PLAN_REVIEW_ROLE = "plan_review";

/** Statuses where the user can still (re-)submit a decision. `submitting`
 *  is included so the dock stays mounted (disabled) while a submit flies. */
const PLAN_ACTIONABLE: readonly PlanReviewStatus[] = [
  "awaiting_review",
  "submitting",
  "deferred",
];

/** Terminal statuses a late plan_review event must never resurrect into an
 *  approvable card (a settled decision is final for that revision). */
const PLAN_TERMINAL: readonly PlanReviewStatus[] = [
  "approved",
  "changes_requested",
  "cancelled",
  "expired",
  "superseded",
];

export function isPlanActionable(status: PlanReviewStatus): boolean {
  return PLAN_ACTIONABLE.includes(status);
}

export function isPlanTerminal(status: PlanReviewStatus): boolean {
  return PLAN_TERMINAL.includes(status);
}

/** Locate the row owning one plan revision; -1 when it was never rendered. */
export function findPlanMessage(
  messages: Message[],
  planId: string,
  revision: number,
): number {
  return messages.findIndex(
    (m) =>
      m.planReview?.planId === planId && m.planReview.revision === revision,
  );
}

/** Locate the streaming draft row for a plan (revision 0, status draft). */
function findDraftMessage(messages: Message[], planId: string): number {
  return messages.findIndex(
    (m) =>
      m.planReview?.planId === planId && m.planReview.status === "draft",
  );
}

/** Row text: the card is not a chat bubble, but search and the anchor rail
 *  read `text`, so carry the title (or a bounded first content line). */
function planRowText(record: PlanReview): string {
  if (record.title.trim()) return record.title.trim();
  return record.content.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Mark every still-open older revision of the same plan superseded by the
 *  revision that just became current (PRD: a new version must be approved
 *  again; only the latest complete version is actionable). */
function supersedeOlderRevisions(
  messages: Message[],
  planId: string,
  revision: number,
): Message[] {
  return messages.map((m) => {
    const cur = m.planReview;
    if (!cur || cur.planId !== planId || cur.revision === revision) return m;
    if (!isPlanActionable(cur.status) && cur.status !== "draft") return m;
    return {
      ...m,
      planReview: {
        ...cur,
        status: "superseded" as const,
        supersededBy: revision,
      },
    };
  });
}

export interface PlanDraftInput {
  planId: string;
  text: string;
  /** true = the event carries the full draft so far, not an increment. */
  replace: boolean;
  engine: string;
  sessionId: string | null;
  runId: string;
  ts: number;
}

/** Insert or grow the draft card for a plan_draft event. Drafts are
 *  previews only: complete=false keeps every approve path disabled until a
 *  full plan_review record arrives. Returns null when nothing changed. */
export function applyPlanDraft(
  messages: Message[],
  input: PlanDraftInput,
): Message[] | null {
  const idx = findDraftMessage(messages, input.planId);
  if (idx >= 0) {
    const cur = messages[idx].planReview!;
    const content = input.replace ? input.text : cur.content + input.text;
    if (content === cur.content) return null;
    const record: PlanReview = {
      ...cur,
      content,
      updatedAt: input.ts,
    };
    const next = messages.slice();
    next[idx] = { ...messages[idx], text: planRowText(record), planReview: record };
    return next;
  }
  const record: PlanReview = {
    planId: input.planId,
    engine: input.engine,
    sessionId: input.sessionId ?? "",
    workspacePath: "",
    runId: input.runId,
    revision: 0,
    title: "",
    content: input.text,
    contentHash: "",
    complete: false,
    reviewKind: "native_request",
    nativePlanId: null,
    execPermission: "",
    status: "draft",
    execution: "not_started",
    decisionIntentAt: null,
    appliedAt: null,
    createdAt: input.ts,
    updatedAt: input.ts,
    supersededBy: null,
  };
  return [
    ...messages,
    {
      role: PLAN_REVIEW_ROLE,
      text: planRowText(record),
      ts: new Date(input.ts).toISOString(),
      seq: messages.length ? messages[messages.length - 1].seq + 1 : 1,
      planReview: record,
    },
  ];
}

/** Apply a full plan_review record: upgrade the draft row in place, update
 *  the same-revision row, or append a new revision (superseding older open
 *  ones). A terminal row is never resurrected by a late duplicate. */
export function applyPlanReview(
  messages: Message[],
  record: PlanReview,
): Message[] | null {
  const same = findPlanMessage(messages, record.planId, record.revision);
  if (same >= 0) {
    const cur = messages[same].planReview!;
    if (isPlanTerminal(cur.status) && !isPlanTerminal(record.status)) {
      return null;
    }
    const next = supersedeOlderRevisions(
      messages,
      record.planId,
      record.revision,
    );
    next[same] = { ...next[same], text: planRowText(record), planReview: record };
    return next;
  }
  const draft = findDraftMessage(messages, record.planId);
  const base = supersedeOlderRevisions(
    messages,
    record.planId,
    record.revision,
  );
  if (draft >= 0) {
    // The draft row keeps its timeline position: preview becomes the card.
    base[draft] = {
      ...base[draft],
      text: planRowText(record),
      planReview: record,
    };
    return base;
  }
  return [
    ...base,
    {
      role: PLAN_REVIEW_ROLE,
      text: planRowText(record),
      ts: new Date(record.updatedAt || Date.now()).toISOString(),
      seq: messages.length ? messages[messages.length - 1].seq + 1 : 1,
      planReview: record,
    },
  ];
}

/** Apply a settled transition (plan_review_settled). Unknown identities are
 *  ignored: the card may belong to a session this window never rendered. */
export function applyPlanSettled(
  messages: Message[],
  planId: string,
  revision: number,
  status: PlanReviewStatus,
): Message[] | null {
  const idx = findPlanMessage(messages, planId, revision);
  if (idx < 0) return null;
  const cur = messages[idx].planReview!;
  if (cur.status === status) return null;
  const next = messages.slice();
  next[idx] = {
    ...messages[idx],
    planReview: { ...cur, status },
  };
  return next;
}

/** Merge persisted plan records into a restored session's message list
 *  (history first-page load). One row per planId+revision; rows a live
 *  event already rendered win by identity. Records are merged oldest
 *  revision first so the supersede pass cannot demote a newer revision
 *  regardless of backend list ordering. Status renders as recorded — an
 *  awaiting row from a dead run is the backend's expire job, not ours. */
export function mergePlanReviewHistory(
  messages: Message[],
  records: PlanReview[],
): Message[] | null {
  let next = messages;
  let changed = false;
  const sorted = [...records].sort(
    (a, b) => a.planId.localeCompare(b.planId) || a.revision - b.revision,
  );
  for (const record of sorted) {
    if (findPlanMessage(next, record.planId, record.revision) >= 0) continue;
    const applied = applyPlanReview(next, record);
    if (applied) {
      next = applied;
      changed = true;
    }
  }
  return changed ? next : null;
}

/** Patch one plan card by identity; shared by the settled handler and the
 *  respond action (optimistic submitting / backend-truth replacement). */
export function patchPlanReview(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  planId: string,
  revision: number,
  patch: (record: PlanReview) => PlanReview,
) {
  set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let changed = false;
    const messages = cur.messages.map((m) => {
      if (m.planReview?.planId !== planId || m.planReview.revision !== revision) {
        return m;
      }
      changed = true;
      return { ...m, planReview: patch(m.planReview) };
    });
    if (!changed) return {};
    return { bySession: { ...s.bySession, [key]: { ...cur, messages } } };
  });
}
