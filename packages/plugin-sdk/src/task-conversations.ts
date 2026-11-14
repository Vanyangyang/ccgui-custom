import type { Disposer } from "./manifest";
import type { HostTaskExcerpt, HostTaskSelection, HostTaskSessionRef } from "./tasks";
import type { HostFixedInstructions } from "./fixed-instructions";

export interface HostTaskMessageReceipt {
  /** Original requested policy, retained even after explicit sendMessageNow. */
  deliveryMode?: "queue";
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
  /** The host fenced this unknown input on an explicit stop and verified its
   * exact native run ended (0.3.49). Delivery remains unknown and is never
   * replayed. Use the conversation's canSend for any new explicit input. */
  stopResolved?: true;
  /** The exact dedicated native turn ended, but delivery of this input remains
   * unknown. The original request must not be replayed. */
  terminalOutcome?: "completed" | "failed" | "cancelled";
  /** Priority requested, but still queued; not native delivery acknowledgement. */
  sendNowRequested?: boolean;
}
export interface HostTaskConversationChild {
  id: string;
  title: string;
  state: string;
  sessionRef: HostTaskSessionRef | null;
  delegation?: { requestId?: string; state: string; result?: string | null };
  /** Native successor/predecessor links for durable operation reconciliation (0.3.37).
   * handed_off is terminal for this child, not completion of its successor. */
  handoffFrom?: { branchId: string; requestId: string; operationId: string };
  handoffTo?: { branchId: string; requestId: string; operationId: string };
}
/** Local planning evidence for an exact pending prompt (0.3.38).
 * Token ranges are heuristic, API prices are references, and historical context
 * is conditional. None of these fields is a bill or a guaranteed upper bound. */
export interface HostTaskRequestCostEstimate {
  method: "utf8-quarter-to-byte-v1";
  textCharacters: number;
  textUtf8Bytes: number;
  textTokens: { lower: number; upper: number };
  /** Omitted when the request's attachments cannot be established. */
  imageCount?: number;
  contextBasis: "current_context" | "last_request" | "unknown" | "model_mismatch";
  contextTokens?: number;
  inputTokens?: { lower: number; upper: number };
  pricing?: {
    basis: "api_standard_reference";
    model: string;
    sourceUrl: string;
    checkedAt: string;
    effectiveFrom: number;
    effectiveUntil: number;
    inputUsdPerMillion: number;
    cacheReadUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
  inputUsd?: { lower: number; upper: number };
  unavailableReason?: "model_price_unverified" | "price_outdated";
  /** Host-localized plain text, shared by the native card, dialog and plugins.
   * Display verbatim as text; never execute, persist, or treat as approval. */
  displayLines?: string[];
}
/** A bounded, read-only projection of a human cost decision belonging to this
 * coordinator or one of its proven descendants. */
export interface HostTaskCostApproval {
  /** Coordinator input, cross-session message, or managed child task. Older hosts may omit the kind. */
  kind?: "coordinatorInput" | "crossSession" | "leader";
  id: string;
  requestId: string;
  sender: HostTaskSessionRef & { title?: string };
  target: HostTaskSessionRef & { title?: string };
  message: string;
  /** Ordered host-managed task-image:<sha256> identities; read-only, never plugin image API IDs or paths. */
  imageRefs?: string[];
  truncated: boolean;
  model: string | null;
  cacheHeat: "hot" | "cold" | "unknown";
  used?: number;
  max?: number;
  usageKind: "current_context" | "last_request" | "unknown";
  /** Historical telemetry only; never an estimate of this request's cost. Older hosts may omit these fields. */
  contextReference?: boolean;
  modelMismatch?: boolean;
  usageModel?: string;
  cacheExpiryDisabled?: boolean;
  cacheReference?: { promptTokens: number; cacheReadTokens: number; observedAt: number; ttlSeconds: number; maxTtlSeconds: number };
  requestEstimate?: HostTaskRequestCostEstimate;
  /** Next cache-window boundary to refresh in the host, not a hit guarantee. */
  costEvidenceRefreshAt?: number;
  capturedAt: number;
  canHandoff: boolean;
  /** Read-only workbench preview is available; it does not execute or cancel. */
  canPreviewHandoff?: boolean;
}
export interface HostTaskConversationSnapshot {
  requestId: string;
  revision: number;
  inputRevision: number;
  workspacePath: string;
  sessionRef: HostTaskSessionRef | null;
  /** Current native choices when fully resolvable; initial task choices before
   * native attachment. Incomplete current choices are omitted, not replaced
   * by a stale initial receipt. These are not upstream model telemetry. */
  selection?: HostTaskSelection;
  effectiveSelection?: HostTaskSelection;
  status: "starting" | "running" | "waiting" | "idle" | "stopping" | "cancelled" | "failed" | "unknown";
  /** Actual native coordinator activity (0.3.44), independent of queued inputs
   * and managed children counted by status. Older hosts may omit this field. */
  nativeStatus?: "idle" | "busy" | "awaiting_permission";
  /** True at an idle reply boundary, including a live Claude process waiting
   * for background tasks. Does not bypass canSend or delivery approval gates. */
  nativeReplyIdle?: boolean;
  /** Transient real host rows, including native sequence, timestamps and pending cards. Never persist these projections. */
  messages: unknown[];
  deliveries: HostTaskMessageReceipt[];
  children: HostTaskConversationChild[];
  costApprovals?: HostTaskCostApproval[];
  costApprovalsTruncated?: boolean;
  /** Existing host prediction for this exact idle coordinator, transient only. */
  composerPrediction?: { id: number; text: string } | null;
  canSend: boolean;
  /** Sticky stop watch, including when all currently observed runs are cancelled.
   * Cleared only after an explicit new input is natively accepted. */
  stopRequested?: boolean;
  canChangeSelection: boolean;
  error?: string;
}
export interface HostTaskMessageRequest {
  /** Requires coordinatorMessageQueue. Wait for the current reply to end;
   * Claude may accept live input while background tasks remain. Omitted retains automatic
   * turn/steer/live delivery. Explicit sendMessageNow may release this wait. */
  deliveryMode?: "queue";
  conversationRequestId: string;
  requestId: string;
  expectedInputRevision: number;
  prompt: string;
  /** Changed guidance remains queued until a full native turn can apply it. */
  fixedInstructions?: HostFixedInstructions;
  /** User-authored display text; native prompt and transcript text are untouched. */
  displayText?: string;
  /** Coordinator-only Codex service tier for this input; omitted follows the app setting. Changed tiers wait for a fresh native turn. */
  codexServiceTier?: "default" | "priority";
  images?: string[];
}
/** Read-only, bounded source context for an owned pending cost decision. The
 * original message is exact; no request is approved, cancelled or sent. */
export interface HostTaskCostHandoffPreview {
  conversationRequestId: string;
  approvalId: string;
  approvalRequestId: string;
  kind: "coordinatorInput" | "crossSession" | "leader";
  source: HostTaskSessionRef;
  model: string | null;
  message: string;
  /** Exact native continuation prompt when different from displayed text. */
  originalPrompt?: string;
  /** Coordinator inputs retain plugin-owned image IDs. Leader previews contain only
   * host-managed task-image:<sha256> references for identity/counting; these cannot
   * be resolved with plugin image APIs. Cross-session previews have no images. */
  images: string[];
  excerpt: HostTaskExcerpt;
  /** SHA-256 of the immutable request identity and complete message. */
  sourceStamp: string;
}
export interface HostTaskCostHandoffRequest {
  conversationRequestId: string;
  expectedRevision: number;
  approvalId: string;
  approvalRequestId: string;
}
/** 0.3.37, capability managedChildCostHandoff. Only an owned pending leader
 * cost review is eligible. The host displays a native human confirmation and
 * revalidates the full source afterwards; plugin booleans cannot approve it.
 * Persist operationId before calling. Never automatically retry an uncertain
 * result: inspect child handoff links to reconcile the native ledger instead. */
export interface HostTaskManagedHandoffRequest extends HostTaskCostHandoffRequest {
  /** Exact sourceStamp returned by previewCostHandoff for this source. */
  sourceStamp: string;
  /** Stable [A-Za-z0-9._:-]{1,128} identity for this exact summary/request. */
  operationId: string;
  /** Nonempty, at most 8000 UTF-16 units, no NUL. Sent exactly as confirmed. */
  summary: string;
  /** Requires managedChildHandoffSelection. Independent successor configuration;
   * omitted preserves the source child's configuration. The host resolves and
   * confirms the exact target before submission. Freeze with operationId. */
  targetSelection?: HostTaskSelection;
}
export type HostTaskManagedHandoffResult = {
  /** accepted proves a native successor link, not completion of its task.
   * Cancellation leaves the ledger unchanged. Unknown outcomes reject; inspect
   * children using the persisted operationId, never automatically resubmit. */
  status: "accepted" | "cancelled";
  snapshot: HostTaskConversationSnapshot;
} | {
  /** Only proves THIS invocation did not cross the host submission boundary.
   * It does not prove this operationId was never submitted by an earlier call
   * or host process. Never retry an unknown operation: reconcile its links.
   * Callers should invoke once per fresh, durably frozen operationId. */
  status: "not_submitted";
  operationId: string;
  /** Host-authored safe display text, without source content or raw exceptions. */
  reason: string;
};
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
  /** Requests a native human confirmation; plugin and model cannot approve directly. */
  | { type: "requestCostReview"; approvalId: string; approvalRequestId: string; decision: "approve" | "cancel" | "handoff" }
  /** Dismiss the exact displayed prediction generation, never a newer one. */
  | { type: "dismissPrediction"; predictionId: number }
);
export interface HostTaskConversationsApi {
  conversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  sendMessage(request: HostTaskMessageRequest): Promise<HostTaskMessageReceipt>;
  messageReceipt(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  cancelMessage(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  /** 0.3.30, capability immediateMessages. Prioritize this original queued input.
   * expectedInputRevision is the selected receipt's inputRevision. May request
   * reply-only yield; never stops descendants or replays an ambiguous delivery. */
  sendMessageNow(conversationRequestId: string, requestId: string, expectedInputRevision: number): Promise<HostTaskMessageReceipt | null>;
  stopConversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  conversationAction(requestId: string, action: HostTaskConversationAction): Promise<HostTaskConversationSnapshot | void>;
  previewCostHandoff?(request: HostTaskCostHandoffRequest): Promise<HostTaskCostHandoffPreview>;
  handoffManagedChild?(request: HostTaskManagedHandoffRequest): Promise<HostTaskManagedHandoffResult>;
  onConversationEvent(callback: (snapshot: HostTaskConversationSnapshot) => void): Disposer;
}
