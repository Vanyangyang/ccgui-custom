import type { Disposer } from "./manifest";
import type { HostTaskSelection, HostTaskSessionRef } from "./tasks";
import type { HostFixedInstructions } from "./fixed-instructions";

export interface HostTaskMessageReceipt {
  conversationRequestId: string;
  requestId: string;
  /** Bounded (280 UTF-16 units, no split surrogate) displayText preview; empty
   * when displayText was omitted. Never generated from a model response. */
  preview: string;
  inputRevision: number;
  status: "queued" | "starting" | "received" | "completed" | "failed" | "cancelled" | "unknown";
  delivery: "queued" | "turn" | "steer" | "live" | null;
  runId: string | null;
  sessionRef: HostTaskSessionRef | null;
  acceptedAt: number;
  updatedAt: number;
  error?: string;
}
export interface HostTaskConversationChild {
  id: string;
  title: string;
  state: string;
  sessionRef: HostTaskSessionRef | null;
  delegation?: { requestId?: string; state: string; result?: string | null };
}
export interface HostTaskConversationSnapshot {
  requestId: string;
  revision: number;
  inputRevision: number;
  workspacePath: string;
  sessionRef: HostTaskSessionRef | null;
  selection?: HostTaskSelection;
  effectiveSelection?: HostTaskSelection;
  status: "starting" | "running" | "waiting" | "idle" | "stopping" | "cancelled" | "failed" | "unknown";
  /** Transient real host rows, including native sequence, timestamps and pending cards. Never persist these projections. */
  messages: unknown[];
  deliveries: HostTaskMessageReceipt[];
  children: HostTaskConversationChild[];
  canSend: boolean;
  /** Sticky stop watch, including when all currently observed runs are cancelled.
   * Cleared only after an explicit new input is natively accepted. */
  stopRequested?: boolean;
  canChangeSelection: boolean;
  error?: string;
}
export interface HostTaskMessageRequest {
  conversationRequestId: string;
  requestId: string;
  expectedInputRevision: number;
  prompt: string;
  /** Changed guidance remains queued until a full native turn can apply it. */
  fixedInstructions?: HostFixedInstructions;
  /** User-authored display text; native prompt and transcript text are untouched. */
  displayText?: string;
  images?: string[];
}
/** Displayed pending identity is mandatory for mutating native actions. sourceId
 * is a renderer routing hint; the owning request and current native record are
 * independently validated by the host. */
export type HostTaskConversationAction = {
  sourceId?: string;
  conversationRequestId: string;
  expectedRevision: number;
} & (
  | { type: "openFile"; path: string }
  | { type: "openChild"; childId: string }
  | { type: "openNative" }
  | { type: "answerQuestion"; seq: number; runId: string; requestId: string; answers: Record<string, string | string[]> | null }
  | { type: "answerGrant"; seq: number; accept: boolean }
  | { type: "answerPlan"; planId: string; planRevision: number; runId: string | null; decision: "approve" | "request_changes" | "defer"; feedback?: string }
);
export interface HostTaskConversationsApi {
  conversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  sendMessage(request: HostTaskMessageRequest): Promise<HostTaskMessageReceipt>;
  messageReceipt(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  cancelMessage(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  stopConversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  conversationAction(requestId: string, action: HostTaskConversationAction): Promise<HostTaskConversationSnapshot | void>;
  onConversationEvent(callback: (snapshot: HostTaskConversationSnapshot) => void): Disposer;
}
