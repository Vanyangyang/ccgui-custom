import type { Message } from "@/lib/ipc";

export type AutoReviewAction =
  | { type: "command"; source: string; command: string; cwd: string }
  | { type: "execve"; source: string; program: string; argv: string[]; cwd: string }
  | { type: "writeStdin"; approvalId: string; processId: string; stdin: string; cwd: string }
  | { type: "applyPatch"; cwd: string; files: string[] }
  | { type: "networkAccess"; target: string; host: string; protocol: string; port: number }
  | { type: "mcpToolCall"; server: string; toolName: string; connectorId: string | null; connectorName: string | null; toolTitle: string | null }
  | { type: "requestPermissions"; reason: string | null; permissions: unknown };

export interface AutoReview {
  /** JSONL history is already scoped to its session and omits this field. */
  threadId?: string;
  turnId: string;
  reviewId: string;
  targetItemId: string | null;
  startedAtMs: number;
  completedAtMs?: number;
  review: {
    status: "inProgress" | "approved" | "denied" | "timedOut" | "aborted";
    riskLevel: string | null;
    userAuthorization: string | null;
    rationale: string | null;
  };
  action: AutoReviewAction;
}

export function readAutoReview(value: unknown): AutoReview | null {
  if (!value || typeof value !== "object") return null;
  const data = value as AutoReview;
  const nullableText = (field: unknown) => field === null || typeof field === "string";
  if (typeof data.reviewId !== "string" || !data.reviewId || (data.threadId !== undefined && typeof data.threadId !== "string") ||
    typeof data.turnId !== "string" || !Number.isFinite(data.startedAtMs) ||
    !data.review || !["inProgress", "approved", "denied", "timedOut", "aborted"].includes(data.review.status) ||
    !nullableText(data.review.riskLevel) || !nullableText(data.review.userAuthorization) || !nullableText(data.review.rationale) ||
    !data.action || !["command", "execve", "writeStdin", "applyPatch", "networkAccess", "mcpToolCall", "requestPermissions"].includes(data.action.type)) return null;
  return data;
}

export function upsertAutoReview(messages: Message[], data: AutoReview): Message[] {
  const index = messages.findIndex((m) => m.role === "auto_review" && readAutoReview(m.args)?.reviewId === data.reviewId);
  if (index >= 0) {
    const old = readAutoReview(messages[index].args)!;
    // Completion is monotonic, including a local abort after cancellation.
    if (old.review.status !== "inProgress") return messages;
    if (JSON.stringify(old) === JSON.stringify(data)) return messages;
    return messages.map((m, i) => i === index ? { ...m, args: data } : m);
  }
  return [...messages, { role: "auto_review", seq: (messages.at(-1)?.seq ?? 0) + 1, text: "", ts: new Date().toISOString(), args: data }];
}

export function abortAutoReviews(messages: Message[]): Message[] {
  let changed = false;
  const next = messages.map((m) => {
    const data = m.role === "auto_review" ? readAutoReview(m.args) : null;
    if (!data || data.review.status !== "inProgress") return m;
    changed = true;
    return { ...m, args: { ...data, completedAtMs: Date.now(), review: { ...data.review, status: "aborted" } } };
  });
  return changed ? next : messages;
}
