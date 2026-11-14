import type { MemoryExtractionDeferred, MemoryExtractionStatus } from "./memory-extraction";

/** Plugin provenance is an assertion, never proof of user authority. */
export interface MemoryReviewSource {
  kind: string;
  role: string;
  complete: boolean;
  /** At most 8192 Unicode code points; extraction provenance JSON is reread natively. */
  text: string;
  engine?: string;
  sessionId?: string;
  messageId?: string;
  workspacePath?: string;
  hostProjectId?: string;
  sourceKind?: string;
  sourceId?: string;
}
export interface MemoryReviewRecord {
  id: string;
  revision: number;
  /** Omitted means active. Withdrawn records are historical context only. */
  state?: "active" | "withdrawn";
  kind: "decision" | "idea" | "observation" | "hypothesis" | "handoff";
  title: string;
  /** <=1600 code points. Oversized records are rejected, never truncated. */
  text: string;
  /** <=4 entries, each <=300 code points. */
  conditions: string[];
  authority: string;
  source: MemoryReviewSource;
}
export interface MemoryReviewRequest {
  requestId: string;
  projectId: string;
  batchId: string;
  root: MemoryReviewRecord;
  /** <=6 candidates; the entire UTF-8 JSON request must be <=32768 bytes. */
  candidates: MemoryReviewRecord[];
  /** Read the original request receipt only; never dispatches a new call. */
  reconcileOnly?: boolean;
}
export interface MemoryReviewJudgment {
  targetId: string;
  targetRevision: number;
  outcome: "keep" | "superseded" | "needs_review" | "conflicted";
  reason: string;
  successorId: string | null;
  scope: "same" | "overlap" | "disjoint" | "unknown";
  evidence: Array<{ recordId: string; quote: string }>;
  dependsOn: string[];
  preserve: Array<{ title: string; text: string; conditions: string[] }>;
}
export interface MemoryReviewBatch {
  version: 1;
  requestId: string;
  projectId: string;
  batchId: string;
  model: "gemini-4-argon";
  records: Array<{ id: string; revision: number }>;
  judgments: MemoryReviewJudgment[];
}
export type MemoryReviewResult = { status: "completed"; batch: MemoryReviewBatch } | MemoryExtractionDeferred;
/** Desktop main owner, host:memory plus the corresponding source grant.
 * Fixed tools-free native AGY Gemini 4 Argon; shares extraction's idle gate,
 * quota backoff, cancellation and maintenance exclusion. automationVersion 1
 * adds shared durable token limits and exact-request receipts; plugins still
 * own the work queue and canonical memory records.
 * The plugin must CAS records/lease before storing the batch. Unknown provenance
 * can be context only. A later import timestamp never proves later evidence. */
export interface HostMemoryReviewApi {
  status(): Promise<MemoryExtractionStatus>;
  /** reason=request_outcome_unknown means inference may have been sent; never
   * automatically retry this operation, including after cancel or maintenance. */
  review(request: MemoryReviewRequest): Promise<MemoryReviewResult>;
  cancel(requestId: string): Promise<void>;
}
