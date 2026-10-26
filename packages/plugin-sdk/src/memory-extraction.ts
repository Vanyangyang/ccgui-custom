/** Exact plugin-owned source. Imported references and managed child chats are
 * deliberately not extraction sources. No transcript is accepted from a plugin. */
export interface MemoryExtractionSource {
  kind: "conversation" | "coordination";
  id: string;
}
export interface MemoryExtractionSessionRef {
  engine: string;
  sessionId: string;
  workspacePath: string;
}
/** Native sequence and Unicode code-point offset. offset=0 consumes the whole
 * row; a positive offset resumes that row. Persist this opaque cursor unchanged.
 * The digest fences rewritten rows; a session change never resets progress. */
export interface MemoryExtractionCursor {
  sessionId: string;
  seq: number;
  offset: number;
  rowDigest?: string;
}
export interface MemoryExtractionContext {
  id: string;
  revision: number;
  kind: string;
  title: string;
  text: string;
  conditions: string[];
  authority?: string;
  updatedAt?: string;
}
export interface MemoryExtractionRelation {
  kind: "supersedes" | "conflicts";
  targetId: string;
  targetRevision: number;
  /** Assistant interpretation; original evidence and records remain authoritative. */
  reason: string;
}
export interface MemoryExtractionEvidence {
  seq: number;
  role: "user" | "assistant";
  quote: string;
}
export interface MemoryExtractionNote {
  kind: "decision" | "idea" | "observation" | "hypothesis" | "handoff";
  title: string;
  text: string;
  conditions: string[];
  relatedIds: string[];
  evidence: MemoryExtractionEvidence[];
  /** Required for formatVersion 2, absent for legacy format 1. */
  relations?: MemoryExtractionRelation[];
}
export interface MemoryExtractionBatch {
  version: 1 | 2;
  projectId: string;
  source: MemoryExtractionSource;
  sessionRef: MemoryExtractionSessionRef;
  fromCursor: MemoryExtractionCursor | null;
  nextCursor: MemoryExtractionCursor;
  inputDigest: string;
  partial: boolean;
  hasMore: boolean;
  model: "gemini-4-argon";
  notes: MemoryExtractionNote[];
}
export interface MemoryExtractionDeferred {
  status: "deferred" | "unavailable" | "invalid_source";
  /** Stable diagnostic code, never provider response text or credentials. */
  reason: string;
  retryAfterMs: number;
}
export type MemoryExtractionResult =
  | { status: "completed"; batch: MemoryExtractionBatch }
  | { status: "empty"; cursor: MemoryExtractionCursor | null }
  | MemoryExtractionDeferred;
export type MemoryExtractionCheckpoint =
  | { status: "ready"; cursor: MemoryExtractionCursor; sessionRef: MemoryExtractionSessionRef }
  | MemoryExtractionDeferred;
export interface MemoryExtractionStatus {
  available: boolean;
  busy: boolean;
  retryAfterMs: number;
  reason?: string;
}
export interface MemoryExtractionSourceRequest {
  projectId: string;
  source: MemoryExtractionSource;
}
export interface MemoryExtractionRequest extends MemoryExtractionSourceRequest {
  requestId: string;
  cursor?: MemoryExtractionCursor | null;
  context?: MemoryExtractionContext[];
  formatVersion?: 2;
  expectedSourceDigest?: string;
}
export interface MemoryExtractionPrepareRequest extends MemoryExtractionSourceRequest {
  cursor?: MemoryExtractionCursor | null;
}
export type MemoryExtractionPreparation = {
  status: "ready";
  /** Local retrieval hint, at most 512 code points; never authoritative evidence. */
  query: string;
  sourceDigest: string;
  fromCursor: MemoryExtractionCursor | null;
  nextCursor: MemoryExtractionCursor | null;
  sessionRef: MemoryExtractionSessionRef;
  partial: boolean;
  hasMore: boolean;
} | MemoryExtractionDeferred;
/** Desktop owner only, host:memory (0.3.25), plus host:chat/host:tasks for the
 * selected source. Fixed tool-less Gemini4/Vertex extraction consumes provider
 * quota. The native host verifies source ownership, project and successful
 * completion; policies, carried references and tool/thinking output are excluded.
 * It waits for global foreground idle and cancels on new foreground input or
 * maintenance. Cancellation cannot guarantee upstream quota or billing refunds.
 * No queue, persistence or main-chat injection is performed by this API.
 * Persist source/cursor metadata and validated notes with their evidence only;
 * generated notes never acquire user-confirmed authority automatically. */
export interface HostMemoryExtractionApi {
  status(): Promise<MemoryExtractionStatus>;
  /** Metadata only. Seed existing sources here to avoid historical backfill. */
  checkpoint(request: MemoryExtractionSourceRequest): Promise<MemoryExtractionCheckpoint>;
  /** 0.3.26: bounded native source selection for local retrieval, no model call.
   * Pass its sourceDigest to formatVersion 2 extract; changed source is deferred. */
  prepare(request: MemoryExtractionPrepareRequest): Promise<MemoryExtractionPreparation>;
  /** One bounded request; a completed empty notes array is a successful batch. */
  extract(request: MemoryExtractionRequest): Promise<MemoryExtractionResult>;
  cancel(requestId: string): Promise<void>;
}
