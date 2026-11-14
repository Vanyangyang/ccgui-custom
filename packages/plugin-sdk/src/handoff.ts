import type { Disposer } from "./manifest";

/** Routing from the host's /handoff preferences, independent of plugin chats. */
export interface HostHandoffSelection {
  engine: "claude" | "codex" | "pi" | "cursor";
  model: string;
  providerId?: string;
  effort?: string;
}
export interface HostHandoffPreferences {
  /** Default automatic compression preference; explicit summarize is allowed when false. */
  enabled: boolean;
  selection: HostHandoffSelection;
}
/** Safe projection of the shared /handoff picker. Contains labels and IDs only,
 * never provider credentials or raw local configuration. */
export interface HostHandoffCatalog {
  selection: HostHandoffSelection;
  engines: Array<{
    id: HostHandoffSelection["engine"];
    label: string;
    available: boolean;
    models: Array<{ id: string; label: string }>;
    providers: Array<{ id: string; label: string }>;
    efforts: Array<{ id: string; label: string }>;
    defaultSelection: HostHandoffSelection;
  }>;
}
export interface HostHandoffRequest {
  handoffId: string;
  requestId: string;
  /** Latest snapshot revision, or 0 for a new handoff. Retry with the original revision. */
  expectedRevision: number;
  /** Explicit plugin-owned text. Omit when source is supplied. */
  text?: string;
  title?: string;
  childContext?: string;
  /** Explicit selection for this operation; omitted follows /handoff preferences. */
  selection?: HostHandoffSelection;
  /** 0.3.39: host resolves the owned pending child and reads all saved visible
   * history. Requires host:tasks as well as host:chat; never accepts a raw session ID. */
  source?: HostHandoffManagedChildSource | HostHandoffCoordinatorSource;
}
/** Owned coordinator's complete saved history; requires host:tasks and
 * coordinatorFullHistoryHandoff. Generates a summary only, without sending or transferring tasks. */
export interface HostHandoffCoordinatorSource {
  kind: "coordinator";
  conversationRequestId: string;
  expectedRevision: number;
}
export interface HostHandoffManagedChildSource {
  kind: "managedChild";
  conversationRequestId: string;
  expectedRevision: number;
  approvalId: string;
  approvalRequestId: string;
  sourceStamp: string;
}
/** Native metadata only. Durations are nonnegative safe integer milliseconds;
 * call counts are at most 1024 and completed + active = started. */
export interface HostHandoffTiming {
  elapsedMs: number;
  readingMs: number;
  segmentsMs: number;
  mergingMs: number;
  verifyingMs: number;
  modelCalls: number;
  completedModelCalls: number;
  activeModelCalls: number;
  /** Sum of ended calls (including failures); overlapping calls are not wall time. */
  modelElapsedMs: number;
  lastModelCallMs?: number;
  longestModelCallMs?: number;
}
/** Native phase counts only; merge rounds can add work, so these are not a total percentage. */
export interface HostHandoffProgress {
  phase: "reading" | "segments" | "merging" | "verifying";
  completed?: number;
  total?: number;
  round?: number;
  /** Host observation time, not a provider token/response timestamp. */
  updatedAt: number;
  /** Optional on older hosts/snapshots. Final statistics remain after completion. */
  timing?: HostHandoffTiming;
}
export interface HostHandoffSnapshot {
  readonly handoffId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly status: "running" | "completed" | "failed" | "unknown" | "discarded";
  readonly selection: HostHandoffSelection;
  /** 0.3.47: fixed when accepted. Old persisted requests may omit it. */
  readonly startedAt?: number;
  /** Optional transient progress; absence does not imply the request has stopped. */
  readonly progress?: HostHandoffProgress;
  readonly summary?: string;
  readonly error?: string;
}
/** Desktop owner only, requires host:chat (0.3.29). Floating views dispatch to
 * their owner. Explicit text never resolves session IDs. An owned managed-child
 * source additionally requires host:tasks and fullHistoryHandoff (0.3.39).
 * This uses the host /handoff compressor without opening a chat.
 * Input identity is durable before native submission;
 * source text is not persisted. One latest request is retained per handoffId. */
export interface HostHandoffApi {
  preferences(): Promise<HostHandoffPreferences>;
  /** 0.3.40: free local discovery for an in-place plugin picker. The selection
   * controls channel-specific models; no dialog, inference or settings write.
   * Floating views dispatch to their owner and display only this safe catalog. */
  catalog?(options?: { selection?: HostHandoffSelection }): Promise<HostHandoffCatalog>;
  /** 0.3.39: same native model/channel/effort picker as /handoff. Does not
   * invoke a model, mutate a destination chat, or change global preferences. */
  chooseModel?(options?: { workspacePath?: string; selection?: HostHandoffSelection }): Promise<HostHandoffSelection | null>;
  /** Freezes host preferences at acceptance and returns running after durable
   * submission. Observe onEvent/inspect for completion. Identical request-ID
   * retries return its current snapshot without invoking the model again.
   * Unknown requests must be inspected/discarded, never automatically replayed. */
  summarize(request: HostHandoffRequest): Promise<HostHandoffSnapshot>;
  inspect(handoffId: string): Promise<HostHandoffSnapshot | null>;
  /** Abandons results only, not the native inference or upstream cost. Late
   * output is ignored; runtime updates stay blocked until native work settles. */
  discard(handoffId: string, requestId: string): Promise<HostHandoffSnapshot | null>;
  onEvent(callback: (snapshot: HostHandoffSnapshot) => void): Disposer;
}
