import type { Disposer, HostTaskConversationsApi, HostTaskConversationSnapshot, HostTaskMessageReceipt, HostTaskMessageRequest, HostTaskReceipt, HostTaskConversationChild, HostTaskCostApproval, HostTaskConversationAction, HostTaskCostHandoffRequest, HostTaskCostHandoffPreview, HostTaskExcerpt } from "@ccgui/plugin-sdk";
import { newId } from "@/lib/id";
import type { HandoffProgressCallback } from "@/lib/handoff-progress";
import type { Message } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import type { PluginStorageBackend } from "./context";
import { TaskPreSpawnError, type HostTaskFacade, type TaskLaunchChoices, type TaskSessionRef, type TaskSettledRun, type TaskTerminalProof, type TaskLifecycleObservation, type HostUserRowIdentity } from "./task-facade";
import { sameTaskPath, taskPathKey } from "./task-paths";
import { leaderWorkspacePathKey } from "@/features/leader/workspace-path";
import type { HostFixedInstructions, HostTaskManagedHandoffRequest, HostTaskManagedHandoffResult, HostTaskSelection } from "@ccgui/plugin-sdk";
import { validateFixedInstructions, sameFixedInstructions, fixedInstructionsIdentity, supportsFixedInstructions } from "./fixed-instructions";
import { taskCostCacheReference, taskCostContextProjection, taskCostTelemetrySignature, taskPendingCostEstimate } from "./task-cost-telemetry";
import type { HostHandoffCoordinatorSource, HostHandoffManagedChildSource, HostHandoffSelection } from "@ccgui/plugin-sdk";
import { isHandoffCompressionSelection } from "@/features/chat/handoff-preferences";
import { taskImageRefs } from "@/features/leader/types";
import { HandoffTargetSelectionError, isHandoffTargetSelection } from "@/features/leader/cost-approval";

const KEY = "__host_tasks_v1:conversations";
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const validPluginImageId = (value: unknown): value is string => validId(value) && !value.startsWith("task-image:");
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const CHILD_TERMINAL = new Set(["completed", "failed", "stopped", "handed_off", "reclaimed"]);
const RECEIPT_STATUS = new Set(["queued", "starting", "received", "completed", "failed", "cancelled", "unknown"]);
type Owned = { receipt: HostTaskReceipt; proven: boolean; launch?: TaskLaunchChoices; displayText?: string; userRow?: HostUserRowIdentity; fixedInstructions?: HostFixedInstructions };
type CodexTier = "default" | "priority";
type TierChoice = CodexTier | "inherit";
const validCodexTier = (value: unknown): value is CodexTier | undefined => value === undefined || value === "default" || value === "priority";
const validDeliveryMode = (value: unknown): value is "queue" | undefined => value === undefined || value === "queue";
interface Input { receipt: HostTaskMessageReceipt; fingerprint: string; prompt: string; images: string[]; deliveryMode?: "queue"; fenceSeq?: number; resumeStopEpoch?: number; displayText?: string; userRow?: HostUserRowIdentity; fixedInstructions?: HostFixedInstructions; codexServiceTier?: CodexTier; approvedCostSignature?: string; terminalProof?: TaskTerminalProof }
const resolvedUnknown = (input: Input) => input.receipt.status === "unknown" && (input.receipt.stopResolved === true || input.receipt.terminalOutcome !== undefined);
const unresolvedInput = (input: Input) => input.receipt.status === "starting" || (input.receipt.status === "unknown" && !resolvedUnknown(input));
const pendingInput = (input: Input) => !TERMINAL.has(input.receipt.status) && !resolvedUnknown(input);
interface RecordState {
  requestId: string; revision: number; inputRevision: number; sessionRef: TaskSessionRef | null;
  stopping: boolean; stopRunId?: string | null; inputs: Input[];
  fixedInstructions?: HostFixedInstructions;
  /** The choice attached to an exact native run, not an assertion of upstream telemetry. */
  serviceTierRun?: { runId: string; tier: TierChoice };
  stopped?: boolean;
  stopTerminalProof?: TaskTerminalProof;
  prioritizedInput?: string;
  stopEpoch?: number;
  /** Only inputs already accepted when the human requested stop can be fenced. */
  stopInputRevision?: number;
  ownershipError?: string;
  children?: Array<HostTaskConversationChild & { parentRef: TaskSessionRef }>;
}
interface Persisted { version: 1; records: RecordState[] }
export interface TaskConversationDependencies {
  pluginId: string; storage: PluginStorageBackend;
  owned(id: string): Promise<Owned>;
  coordinators?(): string[];
  facade(): Promise<HostTaskFacade>;
  confirmCostReview?(approval: HostTaskCostApproval, decision: "approve" | "cancel" | "handoff"): Promise<boolean>;
  confirmManagedHandoff?(approval: HostTaskCostApproval, summary: string, targetSelection?: HostTaskSelection): Promise<boolean>;
  resolveImages(ids: string[]): Promise<string[]>;
  handoffExcerpt?(ref: TaskSessionRef): Promise<HostTaskExcerpt>;
  verify?(id: string): Promise<void>;
  blocked?(id: string): boolean;
  hold(id: string, holding: boolean, stillCurrent?: () => boolean): void | boolean | Promise<void | boolean>;
  cancelInitial?(id: string): Promise<unknown>;
  paused?(): boolean;
  now?(): number;
  runId?(): string;
}
const owners = new WeakMap<PluginStorageBackend, Map<string, symbol>>();
const chains = new WeakMap<PluginStorageBackend, Map<string, Promise<unknown>>>();
const writes = new WeakMap<PluginStorageBackend, Map<string, Promise<unknown>>>();
function mapFor<T>(map: WeakMap<PluginStorageBackend, Map<string, T>>, key: PluginStorageBackend) {
  let value = map.get(key); if (!value) { value = new Map(); map.set(key, value); } return value;
}
const sameRef = (a: TaskSessionRef, b: TaskSessionRef) => a.engine === b.engine && a.sessionId === b.sessionId && sameTaskPath(a.workspacePath, b.workspacePath);
const sameCostRef = (a: TaskSessionRef, b: TaskSessionRef) => a.engine === b.engine && a.sessionId === b.sessionId && leaderWorkspacePathKey(a.workspacePath) === leaderWorkspacePathKey(b.workspacePath);
const sameCostApproval = (a: HostTaskCostApproval, b: HostTaskCostApproval) => a.kind === b.kind && a.id === b.id && a.requestId === b.requestId &&
  JSON.stringify(a.imageRefs ?? []) === JSON.stringify(b.imageRefs ?? []) &&
  a.model === b.model && a.message === b.message && a.truncated === b.truncated && sameCostRef(a.sender, b.sender) && sameCostRef(a.target, b.target);
const sameCostTelemetry = (a: HostTaskCostApproval, b: HostTaskCostApproval) => taskCostTelemetrySignature(a) === taskCostTelemetrySignature(b);
const hasCostContext = (approval: HostTaskCostApproval) => typeof approval.used === "number" && Number.isFinite(approval.used) && approval.used >= 0 && approval.usageKind !== "unknown";
type CostContext = Pick<HostTaskCostApproval, "used" | "max" | "usageKind" | "contextReference" | "modelMismatch" | "usageModel">;
interface CostContextRead {
  record: RecordState; root: TaskSessionRef; expected: HostTaskCostApproval; message: string;
  sourceVersion?: string;
  context?: CostContext;
}
// Each conversation projects at most 32 reviews. Keep memoization scoped to
// its record so unrelated coordinators cannot fill one shared cache.
const COST_CONTEXT_PER_CONVERSATION_LIMIT = 32;
const COST_CONTEXT_FLIGHT_LIMIT = 4;
const validRef = (value: TaskSessionRef | null | undefined): value is TaskSessionRef => !!value &&
  [value.engine, value.sessionId, value.workspacePath].every(v => typeof v === "string" && v.length > 0 && v.length <= 4096);
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const preview = (text?: string) => (text ?? "").slice(0, 280).replace(/[\uD800-\uDBFF]$/, "");
const fingerprintOf = (root: string, id: string, revision: number, prompt: string, images: string[], displayText?: string, fixedInstructions?: HostFixedInstructions, codexServiceTier?: CodexTier, deliveryMode?: "queue") => JSON.stringify([root, id, revision, prompt, images, ...(displayText !== undefined ? [displayText] : []), ...(fixedInstructions ? [{ fixedInstructions: fixedInstructionsIdentity(fixedInstructions) }] : []), ...(codexServiceTier !== undefined ? [{ codexServiceTier }] : []), ...(deliveryMode !== undefined ? [{ deliveryMode }] : [])]);

/** A bounded durable inbox attached to an already-owned, identity-proven task.
 * The native chat store remains the only transcript and delivery authority. */
export function createTaskConversationBridge(deps: TaskConversationDependencies): HostTaskConversationsApi & {
  ready(): Promise<void>; drain(): Promise<void>; capture(): Persisted; restore(value: unknown): void; wake(): void; dispose(): void; attachedTo(ref: TaskSessionRef): boolean; pendingImmediate(): boolean; pendingManagedHandoff(): boolean;
  summarizeManagedHandoff(source: HostHandoffManagedChildSource, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string>;
  summarizeCoordinatorHandoff(source: HostHandoffCoordinatorSource, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string>;
} {
  const records = new Map<string, RecordState>();
  const snapshots = new Map<string, HostTaskConversationSnapshot>();
  type LifecycleRead = { record: RecordState; ref: TaskSessionRef; inputRevision: number; stopEpoch?: number;
    observation?: TaskLifecycleObservation | null; history?: Message[]; historyError?: string; pending?: boolean; retryAt: number; timer?: ReturnType<typeof setTimeout> };
  const lifecycleReads = new Map<string, LifecycleRead>();
  const unavailableTimelines = new Set<string>();
  const timelinePreparations = new Map<string, { pending: boolean; timer?: ReturnType<typeof setTimeout> }>();
  const discardLifecycle = (id: string) => {
    clearTimeout(lifecycleReads.get(id)?.timer); lifecycleReads.delete(id);
  };
  const currentLifecycle = (r: RecordState) => {
    const read = lifecycleReads.get(r.requestId);
    return read?.record === r && r.sessionRef && sameRef(read.ref, r.sessionRef) &&
      read.inputRevision === r.inputRevision && read.stopEpoch === r.stopEpoch && read.observation?.isCurrent() ? read.observation : null;
  };
  function observeLifecycle(r: RecordState): TaskLifecycleObservation | null {
    if (!facade.observeLifecycle || !r.sessionRef) return null;
    const valid = currentLifecycle(r);
    if (valid) return valid;
    let read = lifecycleReads.get(r.requestId);
    if (read && (read.record !== r || !sameRef(read.ref, r.sessionRef) || read.inputRevision !== r.inputRevision ||
      read.stopEpoch !== r.stopEpoch || (read.observation && !read.observation.isCurrent()))) {
      discardLifecycle(r.requestId); read = undefined;
    }
    if (read?.pending || (read && read.retryAt > Date.now())) return null;
    const pending: LifecycleRead = { record: r, ref: { ...r.sessionRef }, inputRevision: r.inputRevision, stopEpoch: r.stopEpoch, pending: true, retryAt: Infinity };
    lifecycleReads.set(r.requestId, pending);
    // Native discovery is bounded by the facade and does not serialize other
    // conversations behind a slow or unavailable historical source.
    void facade.observeLifecycle(pending.ref).catch(() => null).then(observation => {
      if (disposed || ownerMap.get(deps.pluginId) !== token || lifecycleReads.get(r.requestId) !== pending || records.get(r.requestId) !== r) return;
      pending.pending = false;
      pending.observation = observation?.isCurrent() ? observation : null;
      pending.retryAt = Date.now() + 5000;
      if (!pending.observation?.idle) pending.timer = setTimeout(() => { discardLifecycle(r.requestId); wake(); }, 5000);
      wake();
    });
    return null;
  }
  async function prepareTimeline(r: RecordState, available?: TaskLifecycleObservation) {
    if (!r.sessionRef) return;
    if (!facade.observeLifecycle) { await facade.openBackground(r.sessionRef); return; }
    if (facade.conversationState?.(r.sessionRef) && !unavailableTimelines.has(r.requestId)) return;
    if (currentLifecycle(r)?.archived && lifecycleReads.get(r.requestId)?.history !== undefined) return;
    const ref = { ...r.sessionRef }, revision = r.inputRevision, epoch = r.stopEpoch;
    const observation = available?.isCurrent() ? available : await facade.observeLifecycle(ref).catch(() => null);
    if (disposed || ownerMap.get(deps.pluginId) !== token || records.get(r.requestId) !== r || !r.sessionRef || !sameRef(ref, r.sessionRef) ||
      r.inputRevision !== revision || r.stopEpoch !== epoch || !observation?.isCurrent()) return;
    discardLifecycle(r.requestId);
    const read: LifecycleRead = { record: r, ref, inputRevision: revision, stopEpoch: epoch, observation, retryAt: 0 };
    lifecycleReads.set(r.requestId, read);
    if (observation.archived) {
      // Explicit inspection may read saved history, but never acquires a tab or
      // changes its archive marker. Failure is not execution/liveness evidence.
      if (observation.idle && facade.loadPage) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const page = await Promise.race([facade.loadPage(ref, 40, null), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
          if (!disposed && ownerMap.get(deps.pluginId) === token && lifecycleReads.get(r.requestId) === read && currentLifecycle(r) === observation) {
            if (page) read.history = page.messages;
            else read.historyError = i18n.t("crossSession.archivedHistoryUnavailable");
          }
        } catch {
          if (!disposed && ownerMap.get(deps.pluginId) === token && lifecycleReads.get(r.requestId) === read && currentLifecycle(r) === observation)
            read.historyError = i18n.t("crossSession.archivedHistoryUnavailable");
        }
        finally { clearTimeout(timer); }
      }
      return;
    }
    if (!observation.idle || deps.paused?.()) return;
    unavailableTimelines.add(r.requestId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const loaded = await Promise.race([facade.openBackground(ref).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      if (!loaded || disposed || ownerMap.get(deps.pluginId) !== token || records.get(r.requestId) !== r) return;
      // Loading history changes the local snapshot itself. Obtain fresh native
      // evidence afterwards instead of accepting the pre-load idle observation.
      const fresh = await facade.observeLifecycle(ref).catch(() => null);
      if (disposed || ownerMap.get(deps.pluginId) !== token || records.get(r.requestId) !== r || !r.sessionRef || !sameRef(ref, r.sessionRef)) return;
      discardLifecycle(r.requestId);
      if (fresh?.isCurrent()) lifecycleReads.set(r.requestId, { record: r, ref, inputRevision: revision, stopEpoch: epoch, observation: fresh, retryAt: 0 });
      if (r.inputRevision === revision && r.stopEpoch === epoch && fresh?.idle && !fresh.archived && fresh.isCurrent() && facade.conversationState?.(ref)) {
        unavailableTimelines.delete(r.requestId);
      }
    } catch { /* Keep a non-sendable lifecycle observation when history is unavailable. */ }
    finally { clearTimeout(timer); }
  }
  function prepareQueuedTimeline(r: RecordState, observation: TaskLifecycleObservation | null) {
    if (!observation?.idle || observation.archived || !queuedInput(r) || timelinePreparations.has(r.requestId) || deps.paused?.()) return;
    const preparing = { pending: true, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    timelinePreparations.set(r.requestId, preparing);
    void prepareTimeline(r, observation).finally(() => {
      if (disposed || ownerMap.get(deps.pluginId) !== token || timelinePreparations.get(r.requestId) !== preparing) return;
      preparing.pending = false;
      if (r.sessionRef && !unavailableTimelines.has(r.requestId) && facade.conversationState?.(r.sessionRef)) timelinePreparations.delete(r.requestId);
      else preparing.timer = setTimeout(() => { timelinePreparations.delete(r.requestId); wake(); }, 5000);
      wake();
    });
  }
  const messageCopies = new WeakMap<object, { displayText?: string; copy: unknown }>();
  const sequences = new Map<string, number>();
  const listeners = new Set<(snapshot: HostTaskConversationSnapshot) => void>();
  const token = Symbol(deps.pluginId);
  const ownerMap = mapFor(owners, deps.storage);
  const chainMap = mapFor(chains, deps.storage);
  const writeMap = mapFor(writes, deps.storage);
  const cancelledInputs = new Set<string>();
  const stopRequests = new Set<string>();
  const stopErrors = new Map<string, string>();
  const recoveryQueries = new Map<string, { runId: string; retryAt: number; pending?: Promise<TaskSettledRun | null> }>();
  const terminalQueries = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
  let terminalFlights = 0;
  const immediateFlights = new Map<string, { requestId: string; revision: number; promise: Promise<HostTaskMessageReceipt | null> }>();
  const costReviewFlights = new Map<string, Promise<unknown>>();
  const costRefreshTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  function refreshCostAtBoundary(id: string, approvals: HostTaskCostApproval[]) {
    const clock = Date.now();
    const at = approvals.flatMap(approval => [approval.costEvidenceRefreshAt, approval.requestEstimate?.pricing?.effectiveUntil])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > clock)
      .sort((a, b) => a - b)[0];
    const old = costRefreshTimers.get(id);
    if (old?.at === at) return;
    if (old) { clearTimeout(old.timer); costRefreshTimers.delete(id); }
    if (at === undefined || disposed) return;
    const timer = setTimeout(() => {
      costRefreshTimers.delete(id);
      if (!disposed && ownerMap.get(deps.pluginId) === token) wake();
    }, Math.min(2_147_483_647, Math.max(1, at - clock + 1)));
    costRefreshTimers.set(id, { at, timer });
  }
  const managedHandoffFlights = new Map<string, { fingerprint: string; promise: Promise<HostTaskManagedHandoffResult> }>();
  // Process-local conservative evidence only, never a durable submission ledger.
  // Unknown operations must be reconciled after reload, not called again.
  const submittedHandoffOperations = new Set<string>();
  const directCostObserved = new Map<string, { signature: string; capturedAt: number }>();
  // Transient only: never persist history pages or attach them to native records.
  // Failed/empty reads remain memoized until held identity or saved source changes.
  let costContextReads = new WeakMap<RecordState, Map<string, CostContextRead>>();
  const costContextFlights = new Set<CostContextRead>();
  // Map preserves insertion order and permits O(1) removal of superseded work.
  const costContextQueue = new Map<CostContextRead, () => void>();
  function startQueuedCostContexts() {
    while (!disposed && costContextFlights.size < COST_CONTEXT_FLIGHT_LIMIT && costContextQueue.size) {
      const next = costContextQueue.entries().next().value;
      if (!next) break;
      costContextQueue.delete(next[0]);
      next[1]();
    }
  }
  const receiptFor = (r: RecordState, input: Input): HostTaskMessageReceipt => ({ ...structuredClone(input.receipt),
    ...(input.receipt.status === "queued" && r.prioritizedInput === input.receipt.requestId ? { sendNowRequested: true } : {}) });
  ownerMap.set(deps.pluginId, token);
  const now = deps.now ?? Date.now;
  let facade: HostTaskFacade;
  let initialized: Promise<void> | undefined;
  let off: Disposer | undefined;
  let offEvents: Disposer | undefined;
  let disposed = false;
  let restored = false;
  let scheduled = false;
  let wakeAgain = false;
  let observationEpoch = 0;
  let fault: string | undefined;
  const assertOwner = () => { if (disposed || ownerMap.get(deps.pluginId) !== token) throw new Error("Conversation owner is unavailable"); };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = (chainMap.get(deps.pluginId) ?? Promise.resolve()).then(() => { assertOwner(); return work(); });
    chainMap.set(deps.pluginId, result.catch(() => undefined)); return result;
  };
  const capture = (): Persisted => structuredClone({ version: 1, records: [...records.values()] });
  const restore = (raw: unknown) => {
    const value = raw as Persisted;
    if (!value || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 512) throw new Error("Invalid conversation checkpoint");
    const next = new Map<string, RecordState>();
    for (const r of value.records) {
      validateFixedInstructions(r?.fixedInstructions);
      if (!r || !validId(r.requestId) || next.has(r.requestId) || !Number.isSafeInteger(r.revision) || r.revision < 0 ||
        !Number.isSafeInteger(r.inputRevision) || r.inputRevision < 0 || typeof r.stopping !== "boolean" ||
        !Array.isArray(r.inputs) || r.inputs.length > 160 || (r.sessionRef &&
          [r.sessionRef.engine, r.sessionRef.sessionId, r.sessionRef.workspacePath].some(x => typeof x !== "string" || !x))) throw new Error("Invalid conversation record");
      const ids = new Set<string>();
      for (const i of r.inputs) {
        validateFixedInstructions(i?.fixedInstructions);
        const p = i?.receipt;
        if (!p || !validId(p.requestId) || ids.has(p.requestId) || p.conversationRequestId !== r.requestId || !RECEIPT_STATUS.has(p.status) ||
          !Number.isSafeInteger(p.inputRevision) || p.inputRevision < 1 || p.inputRevision > r.inputRevision ||
          (p.runId !== null && (typeof p.runId !== "string" || !p.runId || p.runId.length > 256)) ||
          ![null, "queued", "turn", "steer", "live"].includes(p.delivery) ||
          !validDeliveryMode(i.deliveryMode) || !validDeliveryMode(p.deliveryMode) || i.deliveryMode !== p.deliveryMode ||
          (p.stopResolved !== undefined && (p.stopResolved !== true || p.status !== "unknown" || !p.runId || !p.sessionRef || !r.stopEpoch)) ||
          (p.terminalOutcome !== undefined && (p.status !== "unknown" || p.delivery !== "turn" || !p.runId || !p.sessionRef ||
            !["completed", "failed", "cancelled"].includes(p.terminalOutcome) || !i.terminalProof || i.terminalProof.runId !== p.runId ||
            i.terminalProof.status !== p.terminalOutcome || !validRef(i.terminalProof.sessionRef) || !sameRef(i.terminalProof.sessionRef, p.sessionRef))) ||
          (i.terminalProof !== undefined && p.terminalOutcome === undefined) ||
          (i.fenceSeq !== undefined && (!Number.isSafeInteger(i.fenceSeq) || i.fenceSeq < -1)) ||
          !Number.isFinite(p.acceptedAt) || !Number.isFinite(p.updatedAt) || typeof i.prompt !== "string" || i.prompt.length > 120000 ||
          !Array.isArray(i.images) || i.images.length > 8 || i.images.some(x => !validPluginImageId(x)) ||
          !validCodexTier(i.codexServiceTier) || (i.codexServiceTier !== undefined && r.sessionRef?.engine !== "codex") ||
          (i.approvedCostSignature !== undefined && (typeof i.approvedCostSignature !== "string" || !i.approvedCostSignature || i.approvedCostSignature.length > 32768 || !r.sessionRef)) ||
          (i.displayText !== undefined && (typeof i.displayText !== "string" || i.displayText.length > 120000)) ||
          (p.preview !== undefined && p.preview !== preview(i.displayText)) ||
          (i.userRow && (!Number.isSafeInteger(i.userRow.seq) || typeof i.userRow.text !== "string" || i.userRow.runId !== p.runId || (i.userRow.ts !== null && typeof i.userRow.ts !== "string"))) ||
          typeof i.fingerprint !== "string" || i.fingerprint !== fingerprintOf(r.requestId, p.requestId, p.inputRevision - 1, i.prompt, i.images, i.displayText, i.fixedInstructions, i.codexServiceTier, i.deliveryMode)) throw new Error("Invalid conversation input fence");
        if (p.sessionRef && (!r.sessionRef || !sameRef(p.sessionRef, r.sessionRef))) throw new Error("Conversation input identity mismatch");
        ids.add(p.requestId);
      }
      if ((r.stopEpoch !== undefined && (!Number.isSafeInteger(r.stopEpoch) || r.stopEpoch < 0)) ||
        (r.stopInputRevision !== undefined && (!Number.isSafeInteger(r.stopInputRevision) || r.stopInputRevision < 0 || r.stopInputRevision > r.inputRevision || !r.stopEpoch)) ||
        r.inputs.some(i => i.resumeStopEpoch !== undefined && (!Number.isSafeInteger(i.resumeStopEpoch) || i.resumeStopEpoch < 0))) throw new Error("Invalid conversation stop epoch");
      if (r.serviceTierRun && (r.sessionRef?.engine !== "codex" || typeof r.serviceTierRun.runId !== "string" || !r.serviceTierRun.runId || r.serviceTierRun.runId.length > 256 || !["inherit", "default", "priority"].includes(r.serviceTierRun.tier))) throw new Error("Invalid conversation service tier run");
      if (r.stopTerminalProof && (!r.stopping || !r.sessionRef || !validRef(r.stopTerminalProof.sessionRef) ||
        !sameRef(r.stopTerminalProof.sessionRef, r.sessionRef) || !r.stopRunId || r.stopTerminalProof.runId !== r.stopRunId ||
        !TERMINAL.has(r.stopTerminalProof.status))) throw new Error("Invalid conversation terminal proof");
      if (r.ownershipError !== undefined && (typeof r.ownershipError !== "string" || !r.ownershipError || r.ownershipError.length > 512)) throw new Error("Invalid conversation ownership fence");
      if (r.children !== undefined && (!Array.isArray(r.children) || r.children.length > 4096 || new Set(r.children.map(c => c?.id)).size !== r.children.length ||
        r.children.some(c => !c || !validId(c.id) || typeof c.title !== "string" || typeof c.state !== "string" || !validRef(c.parentRef) || (c.sessionRef !== null && !validRef(c.sessionRef))))) throw new Error("Invalid retained child ownership");
      const restored = structuredClone(r); for (const input of restored.inputs) input.receipt.preview = preview(input.displayText);
      if (r.prioritizedInput !== undefined && (!validId(r.prioritizedInput) || !r.inputs.some(i => i.receipt.requestId === r.prioritizedInput && i.receipt.status === "queued"))) throw new Error("Invalid prioritized conversation input");
      const stopping = r.stopping || r.stopped === true;
      if (stopping && restored.stopInputRevision === undefined && (restored.stopEpoch ?? 0) > 0) {
        // Older hosts saved the explicit stop epoch but not its input boundary.
        // Their later resumes carry that epoch: never include those inputs in
        // the inherited stop, even when their native delivery remains unknown.
        restored.stopInputRevision = restored.inputs.reduce((boundary, input) =>
          input.resumeStopEpoch !== undefined && input.resumeStopEpoch >= restored.stopEpoch!
            ? Math.min(boundary, input.receipt.inputRevision - 1) : boundary, restored.inputRevision);
      }
      next.set(r.requestId, { ...restored, stopping });
    }
    costContextQueue.clear(); costContextReads = new WeakMap();
    for (const id of lifecycleReads.keys()) discardLifecycle(id);
    for (const pending of timelinePreparations.values()) clearTimeout(pending.timer);
    timelinePreparations.clear();
    unavailableTimelines.clear();
    records.clear(); for (const [id, r] of next) records.set(id, r); restored = true;
  };
  const persist = async () => {
    assertOwner();
    const cut = capture();
    const write = (writeMap.get(deps.pluginId) ?? Promise.resolve()).then(() => deps.storage.set(deps.pluginId, KEY, cut));
    writeMap.set(deps.pluginId, write.catch(() => undefined));
    try { await write; }
    catch {
      fault = "Conversation persistence failed; no delivery will be replayed";
      for (const r of records.values()) {
        r.prioritizedInput = undefined;
        for (const i of r.inputs) if (pendingInput(i)) i.receipt = { ...i.receipt, status: "unknown", error: fault, updatedAt: now() };
        await deps.hold(r.requestId, true);
      }
      throw new Error(fault);
    }
  };
  const ensure = () => initialized ??= serial(async () => {
    facade = await deps.facade(); await facade.ready();
    await writeMap.get(deps.pluginId);
    if (!restored) { const saved = await deps.storage.get(deps.pluginId, KEY); if (saved != null) restore(saved); }
    seedCoordinators();
    for (const r of records.values()) {
      for (const input of r.inputs) {
        if (["starting", "received"].includes(input.receipt.status)) {
          // Presence of a run is not proof that this particular input arrived.
          if (input.receipt.status === "starting" || !input.receipt.runId || (!facade.liveRun(input.receipt.runId) && !facade.settledRun(input.receipt.runId, r.sessionRef))) {
            input.receipt = { ...input.receipt, status: "unknown", error: "Delivery outcome could not be confirmed after recovery; not replayed", updatedAt: now() };
          }
        }
      }
    }
    if (records.size) await persist();
    off = facade.subscribe(() => { observationEpoch++; wake(); });
    if (facade.listen) offEvents = await facade.listen(events => {
      if (events.length) observationEpoch++;
      for (const e of events) {
        for (const [id, read] of lifecycleReads) {
          const targets = [read.ref, ...(read.record.children ?? []).flatMap(c => c.sessionRef ? [c.sessionRef] : [])];
          if (targets.some(ref => ref.engine === e.engine && ref.sessionId === e.sessionId) ||
            e.runId === read.record.stopRunId || read.record.inputs.some(i => i.receipt.runId === e.runId)) discardLifecycle(id);
        }
        if (e.kind === "done" || e.kind === "error" || e.kind === "turn_complete") {
          for (const [key, query] of recoveryQueries) if (query.runId === e.runId && !query.pending) recoveryQueries.delete(key);
        }
        const seq = Math.max(sequences.get(e.runId) ?? -1, e.seq);
        sequences.delete(e.runId); sequences.set(e.runId, seq);
        while (sequences.size > 512) sequences.delete(sequences.keys().next().value!);
      }
      void serial(async () => {
        let changed = false;
        for (const event of events) {
          if (event.kind !== "turn_complete") continue;
          for (const r of records.values()) for (const i of r.inputs) {
            if (i.receipt.status !== "received" || i.receipt.runId !== event.runId || !r.sessionRef ||
              event.engine !== r.sessionRef.engine || event.sessionId !== r.sessionRef.sessionId || event.seq <= (i.fenceSeq ?? -1)) continue;
            const interrupted = !!event.data && typeof event.data === "object" && "interrupted" in event.data && event.data.interrupted === true;
            i.receipt = { ...i.receipt, status: interrupted ? "cancelled" : "completed", updatedAt: now() }; changed = true;
          }
        }
        if (changed) await persist();
      }).then(wake).catch(() => {});
    });
  });
  function seedCoordinators() {
    for (const id of deps.coordinators?.() ?? []) if (!records.has(id)) records.set(id, { requestId: id, revision: 0, inputRevision: 0, sessionRef: null, stopping: false, inputs: [] });
  }
  const ownedRecord = async (id: string): Promise<{ record: RecordState; owned: Owned }> => {
    if (!validId(id)) throw new Error("Invalid conversation request id");
    let record = records.get(id);
    let owned: Owned;
    try { owned = await deps.owned(id); }
    catch (error) { if (record) await fenceOwnership(record); throw error; }
    if (!record) {
      if (records.size >= 512) throw new Error("Conversation attachment limit reached");
      record = { requestId: id, revision: 0, inputRevision: 0, sessionRef: null, stopping: false, inputs: [] };
      records.set(id, record);
    }
    if (record.sessionRef && (!owned.proven || !owned.receipt.session || !sameRef(record.sessionRef, owned.receipt.session))) {
      await fenceOwnership(record);
      throw new Error("Immutable conversation identity is no longer proven");
    }
    if (!record.sessionRef && owned.proven && owned.receipt.session) {
      if ([...records.values()].some(other => other !== record && other.sessionRef && sameRef(other.sessionRef, owned.receipt.session!))) throw new Error("Native coordinator is already attached to another initial request");
      record.sessionRef = { ...owned.receipt.session };
    }
    return { record, owned };
  };
  async function fenceOwnership(r: RecordState) {
    const error = "Coordinator identity could not be confirmed; original inputs will not be replayed";
    let changed = r.ownershipError !== error;
    r.ownershipError = error;
    r.prioritizedInput = undefined;
    for (const input of r.inputs) if (!TERMINAL.has(input.receipt.status) && input.receipt.status !== "unknown") {
      input.receipt = { ...input.receipt, status: "unknown", error, updatedAt: now() };
      changed = true;
    }
    await deps.hold(r.requestId, true);
    if (!changed) return;
    const previous = snapshots.get(r.requestId);
    r.revision++;
    await persist();
    if (previous) {
      const view = freeze({ ...previous, revision: r.revision, status: "unknown" as const, nativeStatus: undefined, canSend: false, canChangeSelection: false,
        deliveries: r.inputs.map(input => structuredClone(input.receipt)), error });
      snapshots.set(r.requestId, view);
      for (const callback of listeners) { try { callback(view); } catch { console.error("[plugins] conversation listener failed"); } }
    }
  }
  async function nativeChildren(ref: TaskSessionRef | null, remembered: RecordState["children"] = []) {
    if (!ref) return [];
    const branches = await facade.leaderBranches(true);
    for (const prior of remembered) {
      const current = branches.find(b => b.id === prior.id);
      if (current && (!sameRef(prior.parentRef, { engine: current.parentEngine, sessionId: current.parentSessionId, workspacePath: current.parentWorkspacePath ?? current.workspacePath }) ||
        (prior.sessionRef && current.sessionId && !sameRef(prior.sessionRef, { engine: current.engine, sessionId: current.sessionId, workspacePath: current.workspacePath })))) throw new Error("Native child identity or ownership changed");
    }
    // Retained, natively proven child identities preserve descendant reachability
    // when an intermediate branch is absent from a later snapshot.
    const pending = [ref, ...remembered.flatMap(c => c.sessionRef && c.state !== "reclaimed" ? [c.sessionRef] : [])];
    const parents = new Set<string>();
    const result: Array<{ branch: (typeof branches)[number]; parent: TaskSessionRef }> = [];
    const seen = new Set<string>();
    for (let at = 0; at < pending.length; at++) {
      const parent = pending[at];
      const parentKey = JSON.stringify([parent.engine, parent.sessionId, taskPathKey(parent.workspacePath)]);
      if (parents.has(parentKey)) continue;
      parents.add(parentKey);
      for (const branch of branches.filter(b => b.parentEngine === parent.engine && b.parentSessionId === parent.sessionId &&
        sameTaskPath(b.parentWorkspacePath ?? b.workspacePath, parent.workspacePath))) {
        if (!branch.id || seen.has(branch.id)) throw new Error("Invalid native child ownership graph");
        seen.add(branch.id); result.push({ branch, parent });
        if (branch.sessionId && branch.state !== "reclaimed") pending.push({ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath });
      }
    }
    return result;
  }
  function provenCostRefs(root: TaskSessionRef | null, native: Awaited<ReturnType<typeof nativeChildren>>): TaskSessionRef[] {
    if (!root) return [];
    // Match native leader identity semantics: normalize Windows separators but
    // preserve case and trailing separators. A looser task-scope match alone
    // cannot establish authority to approve another session's request.
    const refKey = (ref: TaskSessionRef) => JSON.stringify([ref.engine, ref.sessionId, leaderWorkspacePathKey(ref.workspacePath)]);
    const byParent = new Map<string, typeof native>();
    for (const item of native) {
      const b = item.branch;
      const key = refKey({ engine: b.parentEngine, sessionId: b.parentSessionId, workspacePath: b.parentWorkspacePath ?? b.workspacePath });
      const group = byParent.get(key) ?? [];
      group.push(item); byParent.set(key, group);
    }
    const refs: TaskSessionRef[] = [{ ...root }], seen = new Set([refKey(root)]);
    for (let at = 0; at < refs.length; at++) {
      for (const { branch } of byParent.get(refKey(refs[at])) ?? []) {
        if (["reclaiming", "reclaimed"].includes(branch.state) || !branch.sessionId) continue;
        const ref = { engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath }, key = refKey(ref);
        if (!seen.has(key)) { seen.add(key); refs.push(ref); }
      }
    }
    return refs;
  }
  async function children(r: RecordState): Promise<{ rows: HostTaskConversationChild[]; costRefs: TaskSessionRef[] }> {
    const native = await nativeChildren(r.sessionRef, r.children);
    const current: NonNullable<RecordState["children"]> = native.map(({ branch: b, parent }) => {
      if (!b.id) throw new Error("Native child identity is unavailable");
      return { id: b.id, title: b.title ?? b.id, state: b.state as string, parentRef: { ...parent },
        sessionRef: b.sessionId ? { engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath } : null,
        ...(b.delegation ? { delegation: { requestId: b.delegation.requestId, state: b.delegation.state,
          ...(b.delegation.result ? { result: b.delegation.result.slice(0, 6000) } : {}) } } : {}),
        ...(b.handoffFrom ? { handoffFrom: { branchId: b.handoffFrom.branchId, requestId: b.handoffFrom.requestId, operationId: b.handoffFrom.operationId } } : {}),
        ...(b.handoffTo ? { handoffTo: { branchId: b.handoffTo.branchId, requestId: b.handoffTo.requestId, operationId: b.handoffTo.operationId } } : {}),
      };
    });
    for (const previous of r.children ?? []) if (!current.some(child => child.id === previous.id)) current.push({ ...previous, state: CHILD_TERMINAL.has(previous.state) ? previous.state : "unknown" });
    if (current.length > 4096) throw new Error("Retained child ownership capacity reached");
    r.children = current;
    return { rows: current.map(({ parentRef: _parent, ...child }) => child), costRefs: provenCostRefs(r.sessionRef, native) };
  }
  async function costOwnerRefs(r: RecordState): Promise<TaskSessionRef[]> {
    if (!r.sessionRef) return [];
    // A branch's execution may be unknown while its native ownership edge is
    // still proven. Conversely, a remembered child that disappeared from the
    // current snapshot must not grant authority to its descendants' requests.
    return provenCostRefs(r.sessionRef, await nativeChildren(r.sessionRef, r.children));
  }
  function projectCostContexts(r: RecordState, refs: TaskSessionRef[], approvals: HostTaskCostApproval[]): HostTaskCostApproval[] {
    const currentOwner = () => !disposed && ownerMap.get(deps.pluginId) === token && records.get(r.requestId) === r &&
      !!r.sessionRef && !r.ownershipError && !fault && !deps.paused?.();
    const reads = costContextReads.get(r) ?? new Map<string, CostContextRead>();
    costContextReads.set(r, reads);
    const forget = (key: string) => { const old = reads.get(key); if (old) costContextQueue.delete(old); reads.delete(key); };
    for (const [key, read] of reads) if (!currentOwner() || !refs.some(ref => sameCostRef(ref, read.expected.sender)) ||
      !approvals.some(approval => sameCostApproval(approval, read.expected) && !hasCostContext(approval))) forget(key);
    if (!currentOwner() || !facade.loadCostApprovalContext || !facade.captureCostApproval) return approvals;
    return approvals.map(approval => {
      if (approval.kind === "coordinatorInput" || hasCostContext(approval) || !refs.some(ref => sameCostRef(ref, approval.sender))) return approval;
      const key = approval.id;
      let captured: ReturnType<NonNullable<HostTaskFacade["captureCostApproval"]>>;
      let sourceVersion: string | undefined;
      try { captured = facade.captureCostApproval!(refs, approval); sourceVersion = facade.costContextVersion?.(approval.target); }
      catch { forget(key); return approval; }
      if (!sameCostApproval(captured.approval, approval)) { forget(key); return approval; }
      let read = reads.get(key);
      if (read && (read.record !== r || read.sourceVersion !== sourceVersion || !sameCostRef(read.root, r.sessionRef!) || !sameCostApproval(read.expected, approval) || read.message !== captured.message)) {
        forget(key); read = undefined;
      }
      if (read) {
        if (!read.context) return approval;
        const enriched = { ...approval, ...read.context };
        return { ...enriched, requestEstimate: taskPendingCostEstimate(enriched, read.message) };
      }
      if (reads.size >= COST_CONTEXT_PER_CONVERSATION_LIMIT || captured.message.length > 260000) return approval;
      const pending: CostContextRead = { record: r, root: { ...r.sessionRef! }, expected: structuredClone(approval), message: captured.message, sourceVersion };
      reads.set(key, pending);
      // The loader needs only the already-proven sender; retaining every
      // descendant for each queued approval would multiply the graph in memory.
      const sourceRefs = [{ engine: approval.sender.engine, sessionId: approval.sender.sessionId, workspacePath: approval.sender.workspacePath }];
      // Never await history on the action queue. A slow read must not delay a
      // human cancellation, inspection, disposal or a different cost review.
      const sameSource = () => {
        try { return facade.costContextVersion?.(pending.expected.target) === pending.sourceVersion; }
        catch { return false; }
      };
      costContextQueue.set(pending, () => {
        if (!currentOwner() || reads.get(key) !== pending || !sameSource()) { if (reads.get(key) === pending) reads.delete(key); return; }
        costContextFlights.add(pending);
        void Promise.resolve().then(() => currentOwner() && reads.get(key) === pending && sameSource()
          ? facade.loadCostApprovalContext!(sourceRefs, structuredClone(pending.expected)) : null)
          .then(result => result && hasCostContext(result) && sameCostApproval(result, pending.expected) ? serial(async () => {
            const unchanged = () => currentOwner() && reads.get(key) === pending && sameSource() && sameCostRef(r.sessionRef!, pending.root);
            if (!unchanged()) return;
            await ownedRecord(r.requestId);
            if (!unchanged()) return;
            const latestRefs = await costOwnerRefs(r);
            if (!unchanged() || !latestRefs.some(ref => sameCostRef(ref, pending.expected.sender))) return;
            const latest = facade.costApprovals?.(latestRefs).items.find(item => sameCostApproval(item, pending.expected));
            if (!latest || hasCostContext(latest)) return;
            const full = facade.captureCostApproval!(latestRefs, latest);
            if (!unchanged() || !sameCostApproval(full.approval, pending.expected) || full.message !== pending.message) return;
            // Whitelist display telemetry only. Native identity, model, cache,
            // capture time and decision capabilities always come from the ledger.
            pending.context = { used: result.used, usageKind: result.usageKind,
              max: typeof result.max === "number" && Number.isFinite(result.max) && result.max > 0 ? result.max : undefined,
              contextReference: typeof result.contextReference === "boolean" ? result.contextReference : undefined,
              modelMismatch: typeof result.modelMismatch === "boolean" ? result.modelMismatch : undefined,
              usageModel: typeof result.usageModel === "string" ? result.usageModel : undefined };
          }) : undefined)
          .catch(() => { /* Missing or stale history never decides or retries a held request. */ })
          .finally(() => {
            costContextFlights.delete(pending);
            startQueuedCostContexts();
            if (currentOwner()) wake();
          });
      });
      startQueuedCostContexts();
      return approval;
    });
  }
  const queuedInput = (r: RecordState) => r.inputs.find(i => i.receipt.status === "queued" && i.receipt.requestId === r.prioritizedInput) ?? r.inputs.find(i => i.receipt.status === "queued");
  function directCost(r: RecordState, input: Input) {
    if (!facade.sessionCostReview || !r.sessionRef) return null;
    const evaluation = facade.sessionCostReview(r.sessionRef);
    if (!evaluation) return { unavailable: true as const };
    if (!evaluation.required || input.approvedCostSignature === evaluation.signature) return null;
    const key = `${r.requestId}\u0000${input.receipt.requestId}`;
    let observed = directCostObserved.get(key);
    if (!observed || observed.signature !== evaluation.signature) {
      observed = { signature: evaluation.signature, capturedAt: evaluation.review.capturedAt };
      directCostObserved.delete(key); directCostObserved.set(key, observed);
      while (directCostObserved.size > 512) directCostObserved.delete(directCostObserved.keys().next().value!);
    }
    const body = input.displayText ?? input.prompt, points = Array.from(body), review = evaluation.review;
    const cacheReference = taskCostCacheReference(review);
    const approval: HostTaskCostApproval = { kind: "coordinatorInput", id: `coordinator-input:${input.receipt.requestId}`, requestId: input.receipt.requestId,
      sender: { ...r.sessionRef }, target: { ...r.sessionRef }, message: points.slice(0, 1200).join(""), truncated: points.length > 1200,
      model: review.model ?? null, cacheHeat: review.cacheHeat, ...taskCostContextProjection(review),
      ...(cacheReference ? { cacheReference } : {}), capturedAt: observed.capturedAt, canHandoff: false, canPreviewHandoff: !!deps.handoffExcerpt };
    approval.requestEstimate = taskPendingCostEstimate(approval, input.prompt, input.images.length);
    return { unavailable: false as const, input, evaluation, approval };
  }
  async function project(r: RecordState, owned: Owned, stopError?: string): Promise<HostTaskConversationSnapshot> {
    if (r.sessionRef && (!facade.conversationState?.(r.sessionRef, r.stopTerminalProof) || unavailableTimelines.has(r.requestId))) observeLifecycle(r);
    await recoverStop(r);
    recoverFinishedInputs(r);
    let error = fault ?? r.ownershipError;
    let childRows: HostTaskConversationChild[] = [], costRefs: TaskSessionRef[] = [];
    try {
      const projection = await children(r); childRows = projection.rows; costRefs = projection.costRefs;
    } catch { error = "Native child ownership could not be confirmed"; childRows = snapshots.get(r.requestId)?.children ?? (r.children ?? []).map(({ parentRef: _parent, ...child }) => child); }
    const liveState = r.sessionRef && !unavailableTimelines.has(r.requestId) ? facade.conversationState?.(r.sessionRef, r.stopTerminalProof) : null;
    const lifecycle = !liveState ? currentLifecycle(r) : null;
    if (!liveState) prepareQueuedTimeline(r, lifecycle);
    const readOnly = !liveState && lifecycle?.idle === true;
    const state = liveState ?? (readOnly ? { messages: lifecycleReads.get(r.requestId)?.history ?? [], runId: null, status: "idle" as const, canDeliver: false } : null);
    const unresolved = r.inputs.some(unresolvedInput);
    const candidate = queuedInput(r);
    const reviewingResume = candidate && r.stopping && candidate.resumeStopEpoch === (r.stopEpoch ?? 0) && childRows.every(child => CHILD_TERMINAL.has(child.state));
    const ownCost = !error && !unresolved && candidate && state?.status === "idle" && state.canDeliver && (!r.stopping || reviewingResume) ? directCost(r, candidate) : null;
    if (ownCost?.unavailable) error = i18n.t("crossSession.coordinatorCostUnavailable");
    const pending = r.inputs.some(pendingInput);
    const childActive = childRows.some(c => !CHILD_TERMINAL.has(c.state));
    let status: HostTaskConversationSnapshot["status"] = "idle";
    if (error || unresolved || childRows.some(c => c.state === "unknown") || owned.receipt.status === "unknown" || (r.sessionRef && !state)) status = "unknown";
    else if (!r.sessionRef) status = owned.receipt.status === "failed" ? "failed" : owned.receipt.status === "cancelled" ? "cancelled" : "starting";
    else if (r.stopping) {
      const settled = r.stopRunId ? r.stopTerminalProof ?? facade.settledRun(r.stopRunId, r.sessionRef) : null;
      status = !childActive && !pending && state?.status === "idle" && (!state.runId || state.runId === r.stopRunId) &&
        (!r.stopRunId || (!facade.liveRun(r.stopRunId) && settled && (lifecycle?.idle || facade.canProjectTerminalRun?.(r.stopRunId, r.sessionRef!) !== false))) ? "cancelled" : "stopping";
    } else if (state?.status === "awaiting_permission") status = "waiting";
    else if (state?.status === "busy" || pending || childActive) status = "running";
    else if (r.stopped) status = "cancelled";
    const latestDelivery = r.inputs.at(-1)?.receipt;
    if (status === "idle" && (latestDelivery ? latestDelivery.status === "failed" : owned.receipt.status === "failed")) status = "failed";
    if (!r.stopping || status === "cancelled") stopErrors.delete(r.requestId);
    else if (stopError) stopErrors.set(r.requestId, stopError);
    const displayedError = error ?? stopError ?? stopErrors.get(r.requestId) ?? (status === "failed" ? latestDelivery?.error ?? owned.receipt.error : undefined)
      ?? (readOnly ? lifecycleReads.get(r.requestId)?.historyError : undefined);
    const costApprovals = deps.confirmCostReview && !error && costRefs.length ? facade.costApprovals?.(costRefs) : undefined;
    const costItems = [...projectCostContexts(r, costRefs, costApprovals?.items ?? []), ...(ownCost && !ownCost.unavailable ? [ownCost.approval] : [])];
    refreshCostAtBoundary(r.requestId, costItems);
    const prediction = facade.composerPrediction && facade.dismissComposerPrediction
      ? r.sessionRef && state?.status === "idle" && state.canDeliver && !r.stopping && !pending && status !== "unknown" && status !== "failed"
        ? facade.composerPrediction(r.sessionRef) : null
      : undefined;
    // The stop fence remains armed after settlement. It is separate from the
    // current write claim and from the permanent native-session reservation.
    // A late owned child reacquires this scope as soon as it is observed.
    let holding = !["idle", "failed", "cancelled"].includes(status);
    const revision = r.inputRevision, epoch = r.stopEpoch;
    const stillCurrent = lifecycle ? () => !disposed && ownerMap.get(deps.pluginId) === token && records.get(r.requestId) === r && r.inputRevision === revision && r.stopEpoch === epoch &&
      currentLifecycle(r) === lifecycle && !r.ownershipError && !fault : undefined;
    if (!holding && stillCurrent && !stillCurrent()) { holding = true; status = "unknown"; }
    const released = !holding && stillCurrent ? await deps.hold(r.requestId, holding, stillCurrent) : await deps.hold(r.requestId, holding);
    if (!holding && (released === false || (stillCurrent && !stillCurrent()))) {
      holding = true; status = "unknown"; await deps.hold(r.requestId, true);
    }
    const previous = snapshots.get(r.requestId);
    const currentLaunch = r.sessionRef ? facade.conversationLaunch?.(r.sessionRef) : null;
    const currentModel = currentLaunch?.model ?? currentLaunch?.defaultModel;
    const currentEffort = currentLaunch?.effort ?? currentLaunch?.defaultEffort;
    const currentProvider = currentLaunch?.providerId ?? currentLaunch?.defaultProvider;
    const currentSelection = r.sessionRef && currentModel && (r.sessionRef.engine === "agy" || currentEffort) && currentProvider
      ? { engine: r.sessionRef.engine, model: currentModel, ...(r.sessionRef.engine === "agy" ? {} : { effort: currentEffort! }), providerId: currentProvider } : undefined;
    const hasNativeSelectionSource = !!r.sessionRef && !!facade.conversationLaunch;
    const displays = [owned, ...r.inputs].filter(item => item.displayText !== undefined && item.userRow);
    const displaysBySeq = new Map<number, typeof displays>();
    for (const display of displays) { const seq = display.userRow!.seq; displaysBySeq.set(seq, [...(displaysBySeq.get(seq) ?? []), display]); }
    const view: HostTaskConversationSnapshot = { requestId: r.requestId, revision: r.revision, inputRevision: r.inputRevision,
      workspacePath: owned.receipt.workspacePath, sessionRef: r.sessionRef ? { ...r.sessionRef } : null,
      selection: hasNativeSelectionSource ? currentSelection : owned.receipt.requestedSelection && { ...owned.receipt.requestedSelection },
      effectiveSelection: hasNativeSelectionSource ? currentSelection : owned.receipt.effectiveSelection && { ...owned.receipt.effectiveSelection },
      status, ...(state ? { nativeStatus: state.status, nativeReplyIdle: state.status === "idle" || state.readyForQueuedInput === true } : {}), messages: (state?.messages ?? []).map(message => {
        const matching = message.role === "user" ? (displaysBySeq.get(message.seq) ?? []).filter(({ userRow: row }) => row!.ts === message.ts && row!.text === message.text &&
          JSON.stringify(row!.images ?? []) === JSON.stringify(message.images ?? [])) : [];
        const displayText = matching.length === 1 ? matching[0].displayText : undefined;
        let cached = messageCopies.get(message);
        if (!cached || cached.displayText !== displayText) {
          const copy = structuredClone(message) as typeof message & { displayText?: string };
          delete copy.displayText; if (displayText !== undefined) copy.displayText = displayText;
          cached = { displayText, copy: freeze(copy) }; messageCopies.set(message, cached);
        }
        return cached.copy;
      }), deliveries: r.inputs.map(i => receiptFor(r, i)), children: childRows,
      ...(costApprovals || costItems.length ? { costApprovals: costItems, costApprovalsTruncated: costApprovals?.truncated ?? false } : {}),
      ...(prediction !== undefined ? { composerPrediction: prediction } : {}),
      stopRequested: r.stopping,
      canSend: !readOnly && !!r.sessionRef && !!state && (!r.stopping || status === "cancelled") && status !== "unknown" && !fault,
      canChangeSelection: !readOnly && !holding, ...(displayedError ? { error: displayedError } : {}),
    };
    const sameMessages = previous?.messages.length === view.messages.length && view.messages.every((message, index) => previous.messages[index] === message);
    // Never stringify the native transcript on every streaming update. Cached
    // immutable rows retain identity; only bounded receipt/child metadata needs
    // structural comparison here.
    if (!previous || !sameMessages || JSON.stringify({ ...previous, revision: 0, messages: undefined }) !== JSON.stringify({ ...view, revision: 0, messages: undefined })) {
      view.revision = ++r.revision; await persist(); freeze(view); snapshots.set(r.requestId, view);
      for (const callback of listeners) { try { callback(view); } catch { console.error("[plugins] conversation listener failed"); } }
    } else return previous;
    return view;
  }
  async function recoverStop(r: RecordState) {
    if (fault || r.ownershipError || !r.stopping || !r.sessionRef) return;
    if (facade.observeLifecycle && !facade.conversationState?.(r.sessionRef, r.stopTerminalProof) && !currentLifecycle(r)?.idle) return;
    const stopRunId = r.stopRunId, ref = { ...r.sessionRef }, epoch = r.stopEpoch;
    const unchanged = () => records.get(r.requestId) === r && r.stopping && r.stopRunId === stopRunId && r.stopEpoch === epoch &&
      !!r.sessionRef && sameRef(r.sessionRef, ref) && !r.ownershipError && !fault;
    const covered = (input: Input) => input.receipt.status === "unknown" && !resolvedUnknown(input) &&
      r.stopInputRevision !== undefined && input.receipt.inputRevision <= r.stopInputRevision;
    const runs = new Set([...(stopRunId && !r.stopTerminalProof ? [stopRunId] : []),
      ...r.inputs.filter(covered).flatMap(input => input.receipt.runId ? [input.receipt.runId] : [])]);
    if (!runs.size) return;
    await ownedRecord(r.requestId);
    if (!unchanged()) return;
    for (const runId of runs) {
      const retain = async (proof: TaskSettledRun | null) => {
        assertOwner();
        if (!proof || !unchanged() || facade.liveRun(runId)) return;
        await ownedRecord(r.requestId);
        if (!unchanged() || (runId === stopRunId && facade.canProjectTerminalRun?.(runId, ref) === false && !currentLifecycle(r)?.idle)) return;
        let changed = false;
        const resolved: Array<{ input: Input; previous: HostTaskMessageReceipt; next: HostTaskMessageReceipt }> = [];
        if (runId === stopRunId && !r.stopTerminalProof) {
          r.stopTerminalProof = { runId, sessionRef: ref, status: proof.status }; changed = true;
        }
        for (const input of r.inputs) if (covered(input) && input.receipt.runId === runId) {
          // This resolves the stop fence, not whether this input was delivered.
          // The old ID, unknown status and error remain durable and unreplayable.
          const next: HostTaskMessageReceipt = { ...input.receipt, stopResolved: true, updatedAt: now() };
          resolved.push({ input, previous: input.receipt, next }); input.receipt = next; changed = true;
        }
        // Persist before allowing a terminal projection or releasing the held scope.
        if (changed) try { await persist(); }
        catch (error) {
          for (const item of resolved) if (item.input.receipt === item.next) item.input.receipt = item.previous;
          throw error;
        }
      };
      const proof = (r.stopTerminalProof?.runId === runId ? r.stopTerminalProof : null) ?? facade.settledRun(runId, ref);
      if (proof) { await retain(proof); continue; }
      if (facade.recoverSettledRun) {
        const inputOnly = runId !== stopRunId;
        const key = JSON.stringify([r.requestId, runId, ref, epoch, inputOnly]);
        let query = recoveryQueries.get(key);
        if (!query || (!query.pending && query.retryAt <= Date.now())) {
          query = { runId, retryAt: Infinity };
          const current = query;
          current.pending = (inputOnly ? facade.recoverSettledRun(runId, ref, { inputOnly: true }) : facade.recoverSettledRun(runId, ref)).catch(() => null).finally(() => {
            current.pending = undefined; current.retryAt = Date.now() + 30000;
          });
          // Archive discovery must not hold the conversation queue: stop, inspect
          // and mounting remain available while native recovery is slow.
          void current.pending.then(result => result ? serial(async () => { await retain(result); }).then(wake) : undefined)
            .catch(() => { if (!disposed && ownerMap.get(deps.pluginId) === token) wake(); });
          recoveryQueries.delete(key); recoveryQueries.set(key, current);
          while (recoveryQueries.size > 512) recoveryQueries.delete(recoveryQueries.keys().next().value!);
        }
      }
    }
  }
  function recoverFinishedInputs(r: RecordState) {
    if (fault || r.ownershipError || r.stopping || !r.sessionRef || !facade.recoverSettledRun || deps.paused?.()) return;
    // Only a dedicated turn can establish that this exact run has ended. A
    // steer/live input shares another turn and remains fenced until explicit stop.
    const input = r.inputs.find(i => i.receipt.status === "unknown" && !resolvedUnknown(i) && i.receipt.delivery === "turn" && i.receipt.runId && i.receipt.sessionRef);
    if (!input || terminalFlights >= 4) return;
    const runId = input.receipt.runId!, ref = { ...r.sessionRef }, requestId = input.receipt.requestId;
    if (facade.liveRun(runId)) return;
    const key = JSON.stringify([r.requestId, requestId, runId, ref]);
    if (terminalQueries.has(key)) return;
    const query: { timer?: ReturnType<typeof setTimeout> } = {};
    terminalQueries.set(key, query);
    terminalFlights++;
    const current = () => !disposed && ownerMap.get(deps.pluginId) === token && records.get(r.requestId) === r &&
      !r.stopping && !r.ownershipError && !fault && !deps.paused?.() && !!r.sessionRef && sameRef(r.sessionRef, ref) && r.inputs.includes(input) &&
      input.receipt.requestId === requestId && input.receipt.runId === runId && input.receipt.delivery === "turn" &&
      input.receipt.status === "unknown" && !resolvedUnknown(input) && !facade.liveRun(runId);
    void facade.recoverSettledRun(runId, ref, { inputOnly: true }).catch(() => null).then(proof => {
      if (!proof || !TERMINAL.has(proof.status)) return;
      return serial(async () => {
        if (!current()) return;
        await ownedRecord(r.requestId);
        if (!current()) return;
        const previous = input.receipt;
        input.terminalProof = { ...proof, runId, sessionRef: ref };
        input.receipt = { ...previous, terminalOutcome: proof.status, updatedAt: now() };
        try { await persist(); }
        catch (error) { input.receipt = previous; input.terminalProof = undefined; throw error; }
      });
    }).catch(() => {}).finally(() => {
      terminalFlights--;
      if (terminalQueries.get(key) !== query) return;
      if (!current()) { terminalQueries.delete(key); if (!disposed) wake(); return; }
      query.timer = setTimeout(() => { terminalQueries.delete(key); if (!disposed) wake(); }, 5000);
      if (!disposed) wake();
    });
  }
  async function reconcile(r: RecordState) {
    for (const i of r.inputs) {
      const p = i.receipt;
      // An unknown delivery never becomes completed merely because the run ended.
      if (p.status !== "received" || !p.runId || !r.sessionRef) continue;
      const proof = facade.settledRun(p.runId, r.sessionRef);
      if (proof) i.receipt = { ...p, status: proof.status, updatedAt: now(), ...(proof.error ? { error: proof.error } : {}) };
    }
  }
  function tierNeedsTurn(r: RecordState, owned: Owned, input: Input, state: ReturnType<NonNullable<HostTaskFacade["conversationState"]>>): boolean {
    if (r.sessionRef?.engine !== "codex" || !state || state.status === "idle") return false;
    const desired = input.codexServiceTier ?? "inherit";
    const known = state.runId && r.serviceTierRun?.runId === state.runId ? r.serviceTierRun.tier
      : state.runId && state.runId === owned.receipt.runId ? (owned.launch?.codexServiceTierOverride ?? "inherit") : undefined;
    // Legacy runs without tier evidence retain their old inherited behavior.
    // An explicit choice, or any earlier per-run override, cannot be steered
    // into an unknown configuration.
    return known === undefined
      ? input.codexServiceTier !== undefined || owned.launch?.codexServiceTierOverride !== undefined || r.serviceTierRun !== undefined
      : known !== desired;
  }
  async function pump() {
    seedCoordinators();
    for (const r of records.values()) {
      assertOwner();
      let owned: Owned;
      try { ({ owned } = await ownedRecord(r.requestId)); }
      catch (error) {
        // A shared persistence failure still fences the whole inbox; an ownership
        // failure belongs only to this immutable coordinator and its write scope.
        if (fault) throw error;
        continue;
      }
      await reconcile(r);
      if (r.stopping && !deps.paused?.()) await stopChildren(r);
      let view = await project(r, owned);
      const input = queuedInput(r);
      const resumesStop = !!input && r.stopping && input.resumeStopEpoch === (r.stopEpoch ?? 0);
      const canResume = resumesStop && view.status !== "unknown" && view.children.every(c => CHILD_TERMINAL.has(c.state)) && !!r.sessionRef && facade.conversationState?.(r.sessionRef)?.status === "idle";
      if (immediateFlights.has(r.requestId) || deps.paused?.() || fault || (!view.canSend && !canResume) || !r.sessionRef || r.inputs.some(unresolvedInput)) continue;
      if (!input || deps.blocked?.(r.requestId) || !facade.conversationState?.(r.sessionRef)?.canDeliver || !facade.continueMessage) continue;
      // Explicit send-now uses the existing durable priority intent to release
      // this wait without mutating the original request or its fingerprint.
      const requiresIdle = input.deliveryMode === "queue" && r.prioritizedInput !== input.receipt.requestId;
      const queueState = facade.conversationState?.(r.sessionRef);
      if (requiresIdle && queueState?.status !== "idle" && queueState?.readyForQueuedInput !== true) continue;
      if (facade.conversationState?.(r.sessionRef)?.status === "idle" && directCost(r, input)) continue;
      const currentInstructions = r.fixedInstructions ?? owned.fixedInstructions;
      const nextInstructions = input.fixedInstructions ?? currentInstructions;
      const instructionsChanged = !sameFixedInstructions(currentInstructions, nextInstructions);
      // A live/steered input cannot replace a running CLI's system context.
      // Retain the accepted input until a full native launch can apply it.
      if (instructionsChanged && facade.conversationState?.(r.sessionRef)?.status !== "idle") continue;
      if (tierNeedsTurn(r, owned, input, facade.conversationState?.(r.sessionRef) ?? null)) continue;
      try {
        if (nextInstructions && !await facade.fixedInstructionsSupported?.(r.sessionRef.engine)) throw new TaskPreSpawnError("Native fixed instructions are unavailable");
        if (input.codexServiceTier !== undefined && await facade.codexServiceTierOverrideSupported?.() !== true) throw new TaskPreSpawnError("Codex service tier override is unavailable");
        const images = await deps.resolveImages(input.images);
        const launch = { ...owned.launch };
        delete launch.codexServiceTierOverride;
        if (input.codexServiceTier !== undefined) launch.codexServiceTierOverride = input.codexServiceTier;
        const onUserRow = input.displayText !== undefined ? async (row: HostUserRowIdentity) => {
          assertOwner(); if (row.runId !== input.receipt.runId) throw new TaskPreSpawnError("Native user row belongs to another input run");
          input.userRow = structuredClone(row); await persist();
          assertOwner();
          if (input.receipt.status === "cancelled" || (r.stopping && input.resumeStopEpoch !== (r.stopEpoch ?? 0)) || deps.paused?.()) throw new TaskPreSpawnError("Conversation delivery paused");
          if (r.stopping && (await children(r)).rows.some(c => !CHILD_TERMINAL.has(c.state))) throw new TaskPreSpawnError("Owned children have not settled; stop intent retained");
        } : undefined;
        const beforeSpawn = facade.sessionCostReview ? async () => {
          assertOwner();
          if (input.receipt.status !== "starting" || input.receipt.delivery !== "turn" || deps.paused?.() ||
            (r.stopping && input.resumeStopEpoch !== (r.stopEpoch ?? 0)) || cancelledInputs.has(`${r.requestId}\u0000${input.receipt.requestId}`)) throw new TaskPreSpawnError("Conversation delivery paused");
          await ownedRecord(r.requestId); await deps.verify?.(r.requestId);
          assertOwner();
          if (input.receipt.status !== "starting" || deps.paused?.() || (r.stopping && input.resumeStopEpoch !== (r.stopEpoch ?? 0)) ||
            cancelledInputs.has(`${r.requestId}\u0000${input.receipt.requestId}`) || deps.blocked?.(r.requestId) || directCost(r, input)) throw new TaskPreSpawnError("Coordinator cost or ownership changed before delivery; input remains queued");
        } : undefined;
        const result = await facade.continueMessage(r.sessionRef, input.prompt, images, (deps.runId ?? (() => `run-${newId()}`))(), async (delivery, runId) => {
          const deliveryPaused = () => input.receipt.status === "cancelled" || (r.stopping && input.resumeStopEpoch !== (r.stopEpoch ?? 0)) || cancelledInputs.has(`${r.requestId}\u0000${input.receipt.requestId}`) || deps.paused?.();
          const assertQueuedTurn = () => {
            if (!requiresIdle) return;
            const live = r.sessionRef && facade.conversationState?.(r.sessionRef);
            const ready = delivery === "turn" ? live?.status === "idle"
              : delivery === "live" && live?.status === "busy" && live.readyForQueuedInput === true;
            if (!ready) throw new TaskPreSpawnError("Queued input requires an idle coordinator reply boundary");
          };
          assertQueuedTurn();
          assertOwner(); if (deliveryPaused()) throw new TaskPreSpawnError("Conversation delivery paused");
          await ownedRecord(r.requestId);
          await deps.verify?.(r.requestId);
          assertOwner(); if (deliveryPaused()) throw new TaskPreSpawnError("Conversation delivery paused");
          if (deps.blocked?.(r.requestId)) throw new TaskPreSpawnError("Conversation scope is held by another native task");
          if (r.stopping && (await children(r)).rows.some(c => !CHILD_TERMINAL.has(c.state))) throw new TaskPreSpawnError("Owned children have not settled; stop intent retained");
          if (nextInstructions && (!r.sessionRef || !await facade.fixedInstructionsSupported?.(r.sessionRef.engine))) throw new TaskPreSpawnError("Native fixed instructions are unavailable for this engine");
          if (instructionsChanged && delivery !== "turn") throw new TaskPreSpawnError("Updated fixed instructions require a new native turn");
          if (delivery === "turn" && directCost(r, input)) throw new TaskPreSpawnError("Coordinator input requires cost review before a new native turn");
          if (delivery !== "turn" && r.sessionRef?.engine === "codex") {
            const live = facade.conversationState?.(r.sessionRef);
            if (!live || live.status === "idle" || live.runId !== runId || tierNeedsTurn(r, owned, input, live)) throw new TaskPreSpawnError("Updated Codex service tier requires a new native turn");
          }
          assertQueuedTurn();
          if (delivery === "turn" && nextInstructions) r.fixedInstructions = fixedInstructionsIdentity(nextInstructions);
          if (delivery === "turn" && r.sessionRef?.engine === "codex") r.serviceTierRun = { runId, tier: input.codexServiceTier ?? "inherit" };
          input.fenceSeq = sequences.get(runId) ?? -1;
          if (r.prioritizedInput === input.receipt.requestId) r.prioritizedInput = undefined;
          input.receipt = { ...input.receipt, status: "starting", stopResolved: undefined, delivery, runId, sessionRef: { ...r.sessionRef! }, updatedAt: now() };
          await persist();
          assertOwner(); if (deliveryPaused()) throw new TaskPreSpawnError("Conversation delivery paused");
          if (r.stopping && (await children(r)).rows.some(c => !CHILD_TERMINAL.has(c.state))) throw new TaskPreSpawnError("Owned children have not settled; stop intent retained");
          if (delivery === "turn" && directCost(r, input)) throw new TaskPreSpawnError("Coordinator cost changed before delivery; input remains queued for review");
          // Persistence and ownership checks can yield; the native store also
          // rechecks idle after this fence before claiming the new turn.
          assertQueuedTurn();
        }, Object.keys(launch).length ? launch : undefined, ...(beforeSpawn ? [onUserRow, beforeSpawn] as const : onUserRow ? [onUserRow] as const : [] as const));
        input.receipt = { ...input.receipt, status: "received", stopResolved: undefined, delivery: result.delivery, runId: result.runId, updatedAt: now(), error: undefined };
        if (r.stopping && input.resumeStopEpoch === (r.stopEpoch ?? 0)) {
          r.stopping = false; r.stopped = false; r.stopRunId = undefined; r.stopTerminalProof = undefined; r.stopInputRevision = undefined;
          for (const key of stopRequests) if (key.startsWith(`${r.requestId}\u0000`)) stopRequests.delete(key);
        }
        if (r.stopping) {
          r.stopRunId = result.runId;
          r.stopTerminalProof = undefined;
          await persist();
          await facade.interrupt(result.runId);
        }
      } catch (error) {
        if (error instanceof TaskPreSpawnError) { input.userRow = undefined; input.fenceSeq = undefined; }
        input.receipt = { ...input.receipt, status: error instanceof TaskPreSpawnError ? (input.receipt.status === "cancelled" || r.stopping || cancelledInputs.has(`${r.requestId}\u0000${input.receipt.requestId}`) ? "cancelled" : "queued") : input.receipt.status === "queued" ? "failed" : "unknown",
          updatedAt: now(), error: error instanceof Error ? error.message : "Continuation delivery failed" };
        if (input.receipt.status !== "queued" && r.prioritizedInput === input.receipt.requestId) r.prioritizedInput = undefined;
      }
      await reconcile(r); await persist(); view = await project(r, owned);
    }
  }
  function wake() {
    if (disposed || !initialized) return;
    if (scheduled) { wakeAgain = true; return; }
    scheduled = true;
    void ensure().then(() => serial(pump)).catch(async () => {
      if (disposed || ownerMap.get(deps.pluginId) !== token) return;
      fault ??= "Conversation ownership or delivery reconciliation failed; execution remains held";
      for (const r of records.values()) {
        await deps.hold(r.requestId, true);
        const previous = snapshots.get(r.requestId);
        if (!previous) continue;
        const unknown = freeze({ ...previous, revision: ++r.revision, status: "unknown" as const, nativeStatus: undefined, canSend: false, canChangeSelection: false, error: fault });
        snapshots.set(r.requestId, unknown);
        for (const callback of listeners) { try { callback(unknown); } catch { console.error("[plugins] conversation listener failed"); } }
      }
      await persist().catch(() => { console.error("[plugins] conversation recovery fence could not be persisted"); });
    }).catch(() => { console.error("[plugins] conversation ownership fence could not be persisted"); }).finally(() => {
      scheduled = false; if (wakeAgain) { wakeAgain = false; wake(); }
    });
  }
  const inspect = async (id: string) => { const { record, owned } = await ownedRecord(id); await reconcile(record); if (record.stopping && !deps.paused?.()) await stopChildren(record); const view = await project(record, owned); await persist(); return view; };
  async function sendNow(id: string, requestId: string, revision: number): Promise<HostTaskMessageReceipt | null> {
    if (!validId(id) || !validId(requestId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid immediate input identity");
    await ensure();
    const active = immediateFlights.get(id);
    if (active) {
      if (active.requestId !== requestId || active.revision !== revision) throw new Error("Another immediate input request is pending");
      return active.promise;
    }
    // Reserve before entering the serial queue. Native yield can be slow; keep
    // cancel/stop and inspection available while it waits outside that queue.
    const promise = (async () => {
      try {
        const prepared = await serial(async () => {
          const { record: r, owned } = await ownedRecord(id);
          const input = r.inputs.find(i => i.receipt.requestId === requestId);
          if (!input) return { receipt: null };
          if (input.receipt.inputRevision !== revision) throw new Error("Conversation input revision conflict");
          if (input.receipt.status !== "queued") return { receipt: receiptFor(r, input) };
          if (!facade.prepareImmediateMessage) throw new Error("Immediate messages require an updated host");
          if (!r.sessionRef) throw new Error("Native coordinator is not available");
          await prepareTimeline(r);
          await deps.verify?.(id);
          await ownedRecord(id);
          const view = await project(r, owned);
          assertOwner();
          if (deps.paused?.() || fault || r.stopping || !view.canSend || deps.blocked?.(id) ||
            input.receipt.status !== "queued" || cancelledInputs.has(`${id}\u0000${requestId}`) ||
            r.inputs.some(unresolvedInput)) throw new Error("Conversation cannot send this queued input now");
          const state = facade.conversationState?.(r.sessionRef);
          if (!state) throw new Error("Native coordinator is not available");
          const currentInstructions = r.fixedInstructions ?? owned.fixedInstructions;
          if (!sameFixedInstructions(currentInstructions, input.fixedInstructions ?? currentInstructions) && state.status !== "idle") throw new Error("Updated fixed instructions require the current native turn to finish");
          if (tierNeedsTurn(r, owned, input, state)) throw new Error("Updated Codex service tier requires the current native turn to finish");
          if (state.status === "idle" && directCost(r, input)) throw new Error("Coordinator input requires cost review before sending");
          r.prioritizedInput = requestId;
          input.receipt = { ...input.receipt, error: undefined, updatedAt: now() };
          await persist(); await project(r, owned);
          return { record: r, input, ref: { ...r.sessionRef }, runId: state.runId };
        });
        if ("receipt" in prepared) return prepared.receipt ?? null;
        const { record: r, input, ref, runId } = prepared;
        await deps.verify?.(id);
        await ownedRecord(id);
        assertOwner();
        if (fault || r.ownershipError || deps.blocked?.(id) || r.inputs.some(unresolvedInput)) throw new Error("Conversation ownership or delivery state changed before immediate input");
        if (input.receipt.status === "queued" && !r.stopping && !deps.paused?.() && !cancelledInputs.has(`${id}\u0000${requestId}`)) {
          await facade.prepareImmediateMessage!(ref, runId);
        }
        return serial(async () => {
          const { owned } = await ownedRecord(id);
          await project(r, owned);
          return receiptFor(r, input);
        });
      } catch (error) {
        await serial(async () => {
          const r = records.get(id), input = r?.inputs.find(i => i.receipt.requestId === requestId);
          if (!r || !input || input.receipt.inputRevision !== revision || input.receipt.status !== "queued") return;
          if (r.prioritizedInput === requestId) r.prioritizedInput = undefined;
          input.receipt = { ...input.receipt, error: error instanceof Error ? error.message : "Immediate input request failed", updatedAt: now() };
          await persist(); const { owned } = await ownedRecord(id); await project(r, owned);
        }).catch(() => {});
        throw error;
      }
    })().finally(() => { immediateFlights.delete(id); wake(); });
    immediateFlights.set(id, { requestId, revision, promise });
    return promise;
  }
  async function requestCostReview(id: string, action: Extract<HostTaskConversationAction, { type: "requestCostReview" }>): Promise<HostTaskConversationSnapshot> {
    // The caller is plugin code. Freeze the decision before any await so a
    // displayed handoff/cancel confirmation cannot turn into an approval.
    action = freeze(structuredClone(action));
    if (typeof action.approvalId !== "string" || !action.approvalId || action.approvalId.length > 4096 ||
      typeof action.approvalRequestId !== "string" || !action.approvalRequestId || action.approvalRequestId.length > 4096 ||
      !["approve", "cancel", "handoff"].includes(action.decision)) throw new Error("Invalid cost review identity");
    const key = `${id}\u0000${action.approvalId}`;
    if (costReviewFlights.has(key)) throw new Error("A cost review is already open");
    const flight = (async () => {
      const expected = await serial(async () => {
        const { record: r, owned } = await ownedRecord(id);
        const view = await project(r, owned);
        const pending = queuedInput(r);
        const reviewingResume = pending && r.stopping && pending.resumeStopEpoch === (r.stopEpoch ?? 0) && view.children.every(child => CHILD_TERMINAL.has(child.state));
        if (deps.paused?.() || !r.sessionRef || action.conversationRequestId !== id || action.expectedRevision !== view.revision ||
          !deps.confirmCostReview) throw new Error("Stale or unavailable cost review");
        const approval = view.costApprovals?.find(item => item.id === action.approvalId && item.requestId === action.approvalRequestId);
        if (!approval || (r.stopping && action.decision === "approve" && !(approval.kind === "coordinatorInput" && reviewingResume)) || (approval.kind !== "coordinatorInput" && !facade.resolveCostApproval) || (action.decision === "handoff" && !approval.canHandoff)) throw new Error("Cost review is no longer available");
        const own = approval.kind === "coordinatorInput" ? directCost(r, queuedInput(r)!) : null;
        if (approval.kind === "coordinatorInput" && (!own || own.unavailable || own.approval.id !== approval.id)) throw new Error("Coordinator cost review changed");
        const refs = approval.kind !== "coordinatorInput" ? await costOwnerRefs(r) : [];
        const cross = approval.kind !== "coordinatorInput" ? facade.captureCostApproval?.(refs, approval) : undefined;
        return { approval: structuredClone(approval), ...(own && !own.unavailable ? { signature: own.evaluation.signature, fingerprint: own.input.fingerprint } : {}), ...(cross ? { fullMessage: cross.message } : {}) };
      });
      // The plugin can request the dialog but cannot supply its result. Do not
      // block the task queue while the user is deciding.
      if (!await deps.confirmCostReview!(expected.approval, action.decision)) return serial(() => inspect(id));
      return serial(async () => {
        const { record: r, owned } = await ownedRecord(id);
        const view = await project(r, owned);
        const approval = view.costApprovals?.find(item => item.id === expected.approval.id && item.requestId === expected.approval.requestId);
        const pending = queuedInput(r);
        const reviewingResume = pending && r.stopping && pending.resumeStopEpoch === (r.stopEpoch ?? 0) && view.children.every(child => CHILD_TERMINAL.has(child.state));
        if (deps.paused?.() || !r.sessionRef || !approval || (r.stopping && action.decision === "approve" && !(approval.kind === "coordinatorInput" && reviewingResume)) || approval.kind !== expected.approval.kind || approval.model !== expected.approval.model || approval.message !== expected.approval.message ||
          approval.truncated !== expected.approval.truncated || !sameCostRef(approval.sender, expected.approval.sender) || !sameCostRef(approval.target, expected.approval.target) ||
          JSON.stringify(approval.imageRefs ?? []) !== JSON.stringify(expected.approval.imageRefs ?? []) ||
          (action.decision === "approve" && !sameCostTelemetry(approval, expected.approval)) ||
          (action.decision === "handoff" && !approval.canHandoff)) throw new Error("Cost review changed before confirmation");
        if (approval.kind === "coordinatorInput") {
          const input = queuedInput(r), own = input && directCost(r, input);
          if (!input || !own || own.unavailable || own.approval.id !== approval.id || own.evaluation.signature !== expected.signature || input.fingerprint !== expected.fingerprint) throw new Error("Coordinator cost review changed before confirmation");
          if (action.decision === "approve") input.approvedCostSignature = own.evaluation.signature;
          else if (action.decision === "cancel") {
            if (r.prioritizedInput === input.receipt.requestId) r.prioritizedInput = undefined;
            input.receipt = { ...input.receipt, status: "cancelled", updatedAt: now(), error: undefined };
          } else throw new Error("Coordinator handoff is not available");
          await persist(); return inspect(id);
        }
        const refs = await costOwnerRefs(r);
        if (expected.fullMessage !== undefined && facade.captureCostApproval?.(refs, approval).message !== expected.fullMessage) throw new Error("Cost review changed before confirmation");
        await facade.resolveCostApproval!(refs, expected.approval, action.decision, ...(expected.fullMessage !== undefined ? [expected.fullMessage] : []));
        return inspect(id);
      });
    })().finally(() => { costReviewFlights.delete(key); wake(); });
    costReviewFlights.set(key, flight);
    return flight;
  }
  async function previewCostHandoff(request: HostTaskCostHandoffRequest, checkInitialRevision = true): Promise<HostTaskCostHandoffPreview> {
    if (!request || !validId(request.conversationRequestId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
      typeof request.approvalId !== "string" || !request.approvalId || request.approvalId.length > 4096 ||
      typeof request.approvalRequestId !== "string" || !request.approvalRequestId || request.approvalRequestId.length > 4096 || !deps.handoffExcerpt) throw new Error("Invalid or unavailable cost handoff preview");
    const frozen = structuredClone(request);
    const read = async (checkRevision: boolean) => {
      const { record: r, owned } = await ownedRecord(frozen.conversationRequestId);
      const view = await project(r, owned);
      if (deps.paused?.() || !r.sessionRef || (checkRevision && view.revision !== frozen.expectedRevision)) throw new Error("Cost handoff source is stale or unavailable");
      const approval = view.costApprovals?.find(item => item.id === frozen.approvalId && item.requestId === frozen.approvalRequestId);
      if (!approval || !(approval.kind === "coordinatorInput" ? approval.canPreviewHandoff : approval.canHandoff)) throw new Error("Cost handoff source is no longer available");
      if (approval.kind === "coordinatorInput") {
        const input = queuedInput(r), own = input && directCost(r, input);
        if (!input || !own || own.unavailable || own.approval.id !== approval.id) throw new Error("Coordinator handoff input changed");
        return { kind: "coordinatorInput" as const, source: { ...r.sessionRef }, sender: { ...r.sessionRef }, model: approval.model, message: input.displayText ?? input.prompt,
          originalPrompt: input.prompt, images: [...input.images], identity: input.fingerprint };
      }
      if (!facade.captureCostApproval) throw new Error("Cost handoff source is unavailable");
      const refs = await costOwnerRefs(r);
      const captured = facade.captureCostApproval(refs, approval);
      if (captured.message.length > 260000) throw new Error("Cost handoff message exceeds the supported size");
      const sender = { engine: approval.sender.engine, sessionId: approval.sender.sessionId, workspacePath: approval.sender.workspacePath };
      return { kind: captured.kind === "cross-session" ? "crossSession" as const : captured.kind, source: { ...approval.target }, sender, model: approval.model, message: captured.message,
        originalPrompt: undefined, images: captured.kind === "leader" ? [...(captured.imageRefs ?? [])] : [] as string[], identity: captured.message };
    };
    const initial = await serial(() => read(checkInitialRevision));
    const historyVersion = facade.costContextVersion?.(initial.source);
    // History loading is read-only and intentionally outside the action queue;
    // confirmation and cancellation stay responsive while it is loading.
    const excerpt = await deps.handoffExcerpt(initial.source);
    return serial(async () => {
      const current = await read(false);
      if (current.kind !== initial.kind || !sameCostRef(current.source, initial.source) || !sameCostRef(current.sender, initial.sender) || current.model !== initial.model ||
        current.message !== initial.message || current.originalPrompt !== initial.originalPrompt || current.identity !== initial.identity ||
        JSON.stringify(current.images) !== JSON.stringify(initial.images)) throw new Error("Cost handoff source changed while history was loading");
      if (facade.costContextVersion?.(initial.source) !== historyVersion) throw new Error("Cost handoff history source changed while loading");
      const targetStatus = facade.inspect(initial.source);
      if (targetStatus === "busy" || targetStatus === "awaiting_permission") throw new Error("Cost handoff source is active or awaiting permission");
      const bytes = new TextEncoder().encode(JSON.stringify([frozen.conversationRequestId, frozen.approvalId, frozen.approvalRequestId,
        initial.kind, initial.source, initial.sender, initial.model, initial.message, initial.originalPrompt ?? null, initial.images, excerpt, historyVersion ?? null]));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sourceStamp = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      // Hashing can yield; repeat the authority check before exposing data.
      const latest = await read(false);
      if (latest.kind !== initial.kind || !sameCostRef(latest.source, initial.source) || !sameCostRef(latest.sender, initial.sender) || latest.model !== initial.model ||
        latest.message !== initial.message || latest.originalPrompt !== initial.originalPrompt || latest.identity !== initial.identity ||
        JSON.stringify(latest.images) !== JSON.stringify(initial.images)) throw new Error("Cost handoff source changed before preview");
      if (facade.costContextVersion?.(initial.source) !== historyVersion) throw new Error("Cost handoff history source changed before preview");
      const latestStatus = facade.inspect(initial.source);
      if (latestStatus === "busy" || latestStatus === "awaiting_permission") throw new Error("Cost handoff source became active before preview");
      return { conversationRequestId: frozen.conversationRequestId, approvalId: frozen.approvalId, approvalRequestId: frozen.approvalRequestId,
        kind: initial.kind, source: initial.source, model: initial.model, message: initial.message,
        ...(initial.originalPrompt !== undefined ? { originalPrompt: initial.originalPrompt } : {}), images: initial.images, excerpt, sourceStamp };
    });
  }
  async function summarizeCoordinatorHandoff(input: HostHandoffCoordinatorSource, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string> {
    const source = structuredClone(input), chosen = structuredClone(selection);
    if (!source || source.kind !== "coordinator" || Object.keys(source).some(key => !["kind", "conversationRequestId", "expectedRevision"].includes(key)) ||
      !validId(source.conversationRequestId) || !Number.isSafeInteger(source.expectedRevision) || source.expectedRevision < 1 ||
      !isHandoffCompressionSelection(chosen)) throw new Error("Invalid coordinator Handoff summary source");
    await ensure();
    if (!facade.summarizeHandoff || await facade.fullHistoryHandoffSupported?.() !== true) throw new Error("Full-history Handoff requires an updated native host");
    const read = async () => {
      const { record: r, owned } = await ownedRecord(source.conversationRequestId);
      assertOwner();
      if (!r.sessionRef || deps.paused?.() || r.stopping || r.ownershipError || fault) throw new Error("Coordinator Handoff source is unavailable");
      const ref = { ...r.sessionRef }, version = facade.costContextVersion?.(ref), observed = observationEpoch;
      const view = await project(r, owned);
      // project yields to native child reads, hold persistence and listeners.
      // Its earlier owner snapshot cannot authorize submission after those awaits.
      const latest = await ownedRecord(source.conversationRequestId);
      const check = () => {
        assertOwner();
        const current = facade.conversationState?.(ref);
        if (observed !== observationEpoch || latest.record !== r || records.get(source.conversationRequestId) !== r || deps.paused?.() || fault || r.ownershipError || r.stopping ||
          !r.sessionRef || !sameCostRef(r.sessionRef, ref) || !latest.owned.proven || !latest.owned.receipt.session ||
          !sameCostRef(ref, latest.owned.receipt.session) || leaderWorkspacePathKey(latest.owned.receipt.workspacePath) !== leaderWorkspacePathKey(ref.workspacePath) ||
          latest.owned.receipt.status === "unknown" || view.revision !== source.expectedRevision || r.revision !== view.revision ||
          !view.sessionRef || !sameCostRef(view.sessionRef, ref) || !view.canChangeSelection || !["idle", "failed", "cancelled"].includes(view.status) ||
          view.nativeStatus !== "idle" || current?.status !== "idle" || (current.runId && facade.liveRun(current.runId)) || deps.blocked?.(r.requestId) ||
          r.inputs.some(pendingInput) || view.children.some(child => !CHILD_TERMINAL.has(child.state) ||
            child.delegation && !CHILD_TERMINAL.has(child.delegation.state)) ||
          facade.costContextVersion?.(ref) !== version) throw new Error("Coordinator Handoff source is stale or unavailable");
      };
      check();
      const childContext = view.children.length
        ? "子任务报告（仅供参考，不代表独立验收；较长报告可能截断）：\n" + JSON.stringify(view.children).slice(0, 5800).replace(/[\uD800-\uDBFF]$/, "")
        : undefined;
      return { ref, version, status: view.status, childContext, check };
    };
    // Keep inference outside the action queue so cancellation and input remain
    // responsive. Any changed source invalidates the returned summary.
    const started = await serial(async () => {
      const initial = await read();
      initial.check();
      return { initial, completion: onProgress ? facade.summarizeHandoff!(initial.ref, chosen, initial.childContext, onProgress) : initial.childContext
        ? facade.summarizeHandoff!(initial.ref, chosen, initial.childContext)
        : facade.summarizeHandoff!(initial.ref, chosen) };
    });
    const summary = await started.completion;
    return serial(async () => {
      const latest = await read();
      latest.check();
      if (!sameCostRef(latest.ref, started.initial.ref) || latest.version !== started.initial.version || latest.status !== started.initial.status || latest.childContext !== started.initial.childContext) {
        throw new Error("Coordinator Handoff source changed during compression");
      }
      return summary;
    });
  }
  async function summarizeManagedHandoff(input: HostHandoffManagedChildSource, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string> {
    const source = structuredClone(input), chosen = structuredClone(selection);
    if (source.kind !== "managedChild" || !/^[a-f0-9]{64}$/.test(source.sourceStamp) || !isHandoffCompressionSelection(chosen)) throw new Error("Invalid managed Handoff summary source");
    await ensure();
    if (!facade.summarizeHandoff || await facade.fullHistoryHandoffSupported?.() !== true) throw new Error("Full-history Handoff requires an updated native host");
    const verify = async () => {
      const { record, owned } = await ownedRecord(source.conversationRequestId);
      assertOwner();
      if (deps.paused?.() || record.stopping || record.ownershipError || !record.sessionRef || !owned.proven || !owned.receipt.session ||
        !sameCostRef(record.sessionRef, owned.receipt.session)) throw new Error("Managed Handoff summary owner changed");
      return project(record, owned);
    };
    const firstView = await verify();
    if (firstView.revision !== source.expectedRevision) throw new Error("Managed Handoff summary source is stale");
    const preview = await previewCostHandoff(source);
    if (preview.kind !== "leader" || preview.sourceStamp !== source.sourceStamp) throw new Error("Managed Handoff summary source changed");
    const version = facade.costContextVersion?.(preview.source);
    const result = await (onProgress ? facade.summarizeHandoff(preview.source, chosen, undefined, onProgress) : facade.summarizeHandoff(preview.source, chosen));
    const latestView = await verify();
    const latest = await previewCostHandoff({ ...source, expectedRevision: latestView.revision });
    if (latest.kind !== "leader" || latest.sourceStamp !== source.sourceStamp || facade.costContextVersion?.(preview.source) !== version) throw new Error("Managed Handoff history changed during compression");
    return result;
  }
  async function handoffManagedChild(input: HostTaskManagedHandoffRequest): Promise<HostTaskManagedHandoffResult> {
    // Copy before the first await: mutable plugin objects never change what the
    // human sees or what is submitted under a durable operation identity.
    const request = freeze(structuredClone(input));
    if (!request || !validId(request.operationId)) throw new Error("Invalid managed child handoff operation identity");
    let ambiguousOperation = submittedHandoffOperations.has(request.operationId);
    let failureReason = "crossSession.managedHandoffRequestInvalid";
    const notSubmitted = (error: unknown): HostTaskManagedHandoffResult => ({
      status: "not_submitted", operationId: request.operationId,
      reason: i18n.t("crossSession.managedHandoffNotSubmittedReason", {
        reason: error instanceof HandoffTargetSelectionError ? error.message : i18n.t(failureReason),
      }),
    });
    try {
    if (!validId(request.conversationRequestId) ||
      !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
      typeof request.sourceStamp !== "string" || !/^[a-f0-9]{64}$/.test(request.sourceStamp) ||
      typeof request.summary !== "string" || !request.summary.trim() || request.summary.length > 8000 || request.summary.includes("\0") ||
      typeof request.approvalId !== "string" || !request.approvalId || request.approvalId.length > 4096 ||
      typeof request.approvalRequestId !== "string" || !request.approvalRequestId || request.approvalRequestId.length > 4096 ||
      request.targetSelection !== undefined && !isHandoffTargetSelection(request.targetSelection)) throw new Error("Invalid managed child handoff request");
    await ensure();
    const id = request.conversationRequestId, key = `${id}\u0000${request.approvalId}`;
    const targetKey = (selection: HostTaskSelection) => [selection.engine, selection.model, selection.providerId, selection.effort ?? null];
    const fingerprint = JSON.stringify([id, request.expectedRevision, request.approvalId, request.approvalRequestId, request.sourceStamp, request.operationId, request.summary,
      ...(request.targetSelection ? [targetKey(request.targetSelection)] : [])]);
    const active = managedHandoffFlights.get(request.operationId);
    if (active) {
      if (active.fingerprint !== fingerprint) { ambiguousOperation = true; throw new Error("Handoff operation identity already has a different payload"); }
      return await active.promise;
    }
    if (ambiguousOperation) throw new Error("Handoff operation was already submitted; inspect child links before any further action");
    if (submittedHandoffOperations.size >= 4096) throw new Error("Managed child handoff operation capacity reached");
    if (costReviewFlights.has(key)) throw new Error("A cost review is already open");
    const read = async (checkRevision: boolean) => {
      const { record: r, owned } = await ownedRecord(id);
      const view = await project(r, owned);
      assertOwner();
      if (!deps.confirmManagedHandoff || !facade.handoffCostApproval || !deps.handoffExcerpt ||
        deps.paused?.() || fault || r.ownershipError || r.stopping || !r.sessionRef ||
        !owned.proven || !owned.receipt.session || !sameCostRef(r.sessionRef, owned.receipt.session) ||
        (checkRevision && view.revision !== request.expectedRevision)) throw new Error("Managed child handoff is stale or unavailable");
      const approval = view.costApprovals?.find(a => a.id === request.approvalId && a.requestId === request.approvalRequestId);
      if (!approval || approval.kind !== "leader" || !approval.canHandoff) throw new Error("Managed child handoff requires an owned pending leader cost review");
      const native = await nativeChildren(r.sessionRef, r.children), refs = provenCostRefs(r.sessionRef, native);
      const child = native.find(({ branch: b }) => approval.id === `leader:${b.id}` && b.sessionId &&
        sameCostRef(approval.sender, { engine: b.parentEngine, sessionId: b.parentSessionId, workspacePath: b.parentWorkspacePath ?? b.workspacePath }) &&
        sameCostRef(approval.target, { engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath }));
      const branch = child?.branch;
      const pending = branch?.delegation?.state === "awaiting_cost_approval" ? branch.delegation.costApproval : branch?.state === "awaiting_cost_approval" ? branch.costApproval : undefined;
      if (!branch || !pending || pending.requestId !== approval.requestId || !refs.some(ref => sameCostRef(ref, approval.sender))) throw new Error("Managed child identity or ownership changed");
      // Native graph reads yield. Refresh the coordinator's ownership proof
      // again before capturing the ledger record or starting a native action.
      const refreshedOwner = await ownedRecord(id);
      assertOwner();
      if (r.ownershipError || r.stopping || deps.paused?.() || fault || !refreshedOwner.owned.proven || !refreshedOwner.owned.receipt.session ||
        !sameCostRef(r.sessionRef, refreshedOwner.owned.receipt.session)) throw new Error("Managed child owner is unavailable");
      const full = facade.captureCostApproval?.(refs, approval);
      const nativeMessage = branch.delegation?.state === "awaiting_cost_approval" ? branch.delegation.task : branch.task;
      const nativeImages = taskImageRefs(branch.delegation?.state === "awaiting_cost_approval" ? branch.delegation.images : branch.images);
      if (!full || full.kind !== "leader" || !sameCostApproval(full.approval, approval) || full.message !== nativeMessage) throw new Error("Managed child cost review changed");
      if (JSON.stringify(full.imageRefs ?? []) !== JSON.stringify(nativeImages) || JSON.stringify(approval.imageRefs ?? []) !== JSON.stringify(nativeImages)) throw new Error("Managed child image identities changed");
      return { approval: structuredClone(approval), message: full.message, images: [...nativeImages], root: { ...r.sessionRef }, refs, revision: view.revision };
    };
    const same = (a: Awaited<ReturnType<typeof read>>, b: Awaited<ReturnType<typeof read>>) =>
      sameCostRef(a.root, b.root) && sameCostApproval(a.approval, b.approval) && a.message === b.message && JSON.stringify(a.images) === JSON.stringify(b.images);
    const resolveTarget = async () => {
      if (!request.targetSelection) return undefined;
      failureReason = "crossSession.managedHandoffTargetResolutionFailed";
      if (!facade.resolveHandoffSelection || await facade.managedChildHandoffSelectionSupported?.() !== true) {
        failureReason = "crossSession.managedHandoffTargetUnsupported";
        throw new Error("Selecting a handoff successor model requires an updated native host");
      }
      const resolved = await facade.resolveHandoffSelection({ ...request.targetSelection });
      if (!isHandoffTargetSelection(resolved) || resolved.engine !== request.targetSelection.engine || resolved.providerId !== request.targetSelection.providerId) {
        throw new Error("Native handoff target selection is invalid");
      }
      return freeze({ ...resolved });
    };
    const flight = (async (): Promise<HostTaskManagedHandoffResult> => {
      failureReason = "crossSession.managedHandoffSourceUnavailable";
      if (await facade.managedChildHandoffSupported?.() !== true) throw new Error("Managed child handoff requires an updated native host");
      // Validate the user's displayed revision before slow model discovery.
      // Subsequent checks bind the exact held request and history stamp; unrelated
      // parent/peer updates must not invalidate this already-captured source.
      const expected = await serial(() => read(true));
      const targetSelection = await resolveTarget();
      failureReason = "crossSession.managedHandoffSourceUnavailable";
      const initial = await previewCostHandoff(request, false);
      failureReason = "crossSession.managedHandoffSourceChanged";
      if (initial.kind !== "leader" || initial.sourceStamp !== request.sourceStamp) throw new Error("Managed child handoff source stamp changed");
      const beforeDialog = await serial(() => read(false));
      if (!same(expected, beforeDialog)) throw new Error("Managed child handoff changed before confirmation");
      // The host confirmation gets the full frozen pending message. The card's
      // shortened projection must not hide the tail the human is authorizing.
      // Neither the dialog nor history loading occupies the global action queue.
      const confirmation = freeze({ ...structuredClone(expected.approval), message: expected.message, truncated: false });
      failureReason = "crossSession.managedHandoffConfirmationUnavailable";
      const accepted = targetSelection
        ? await deps.confirmManagedHandoff!(confirmation, request.summary, targetSelection)
        : await deps.confirmManagedHandoff!(confirmation, request.summary);
      if (accepted !== true) return { status: "cancelled", snapshot: await serial(() => inspect(id)) };
      if (targetSelection) {
        const latestTarget = await resolveTarget();
        if (!latestTarget || JSON.stringify(targetKey(latestTarget)) !== JSON.stringify(targetKey(targetSelection))) {
          throw new HandoffTargetSelectionError("HANDOFF_TARGET_CHANGED");
        }
      }
      failureReason = "crossSession.managedHandoffSourceChanged";
      const confirmed = await serial(() => read(false));
      if (!same(expected, confirmed)) throw new Error("Managed child handoff changed during confirmation");
      const refreshed = await previewCostHandoff({ ...request, expectedRevision: confirmed.revision }, false);
      if (refreshed.kind !== "leader" || refreshed.sourceStamp !== request.sourceStamp) throw new Error("Managed child handoff source stamp changed during confirmation");
      const started = await serial(async () => {
        const current = await read(false);
        assertOwner();
        if (!same(expected, current) || deps.paused?.() || records.get(id)?.stopping) throw new Error("Managed child handoff changed before submission");
        // Start synchronously after the last authority check, but return its
        // promise in an object so native launch cannot hold the serial queue.
        // This line is the submission boundary. Even a synchronous facade
        // throw must remain unknown; never turn a possibly sent call into an
        // editable not_submitted result.
        submittedHandoffOperations.add(request.operationId);
        return { completion: targetSelection
          ? facade.handoffCostApproval!(current.refs, expected.approval, expected.message, request.summary, request.operationId, targetSelection)
          : facade.handoffCostApproval!(current.refs, expected.approval, expected.message, request.summary, request.operationId) };
      });
      await started.completion;
      const snapshot = await serial(() => inspect(id));
      const previous = snapshot.children.find(child => `leader:${child.id}` === request.approvalId);
      const successor = previous?.handoffTo && snapshot.children.find(child => child.id === previous.handoffTo!.branchId);
      if (previous?.state !== "handed_off" || previous.handoffTo?.operationId !== request.operationId || previous.handoffTo.requestId !== request.approvalRequestId ||
        !successor || successor.id === previous.id || successor.handoffFrom?.branchId !== previous.id ||
        successor.handoffFrom.operationId !== request.operationId || successor.handoffFrom.requestId !== request.approvalRequestId) {
        throw new Error("Managed child handoff outcome is unknown; inspect child links using operationId before any further action");
      }
      return { status: "accepted", snapshot };
    })().catch(error => {
      if (submittedHandoffOperations.has(request.operationId)) throw error;
      // Coalesced calls share the same classified preflight result as well as
      // the same submission boundary; no caller reconstructs another reason.
      return notSubmitted(error);
    }).finally(() => { managedHandoffFlights.delete(request.operationId); costReviewFlights.delete(key); wake(); });
    managedHandoffFlights.set(request.operationId, { fingerprint, promise: flight });
    costReviewFlights.set(key, flight);
    return await flight;
    } catch (error) {
      if (ambiguousOperation || submittedHandoffOperations.has(request.operationId)) throw error;
      return notSubmitted(error);
    }
  }
  return {
    async ready() { await ensure(); },
    async previewCostHandoff(request) { await ensure(); return previewCostHandoff(request); },
    handoffManagedChild,
    summarizeManagedHandoff,
    summarizeCoordinatorHandoff,
    pendingImmediate() { return immediateFlights.size > 0 || [...timelinePreparations.values()].some(p => p.pending); },
    pendingManagedHandoff() { return managedHandoffFlights.size > 0; },
    attachedTo(ref) { return [...records.values()].some(r => r.sessionRef && sameRef(r.sessionRef, ref)); },
    async drain() { await ensure(); await serial(pump); }, capture, restore, wake,
    async conversation(id) { await ensure(); return serial(async () => { const { record } = await ownedRecord(id); await prepareTimeline(record); return inspect(id); }); },
    async sendMessage(request: HostTaskMessageRequest) {
      validateFixedInstructions(request?.fixedInstructions);
      if (!request || !validId(request.requestId) || !Number.isSafeInteger(request.expectedInputRevision) || request.expectedInputRevision < 0 ||
        typeof request.prompt !== "string" || request.prompt.length > 120000 || (!request.prompt.trim() && !request.images?.length) ||
        !validCodexTier(request.codexServiceTier) || !validDeliveryMode(request.deliveryMode) ||
        (request.displayText !== undefined && (typeof request.displayText !== "string" || request.displayText.length > 120000)) ||
        (request.images !== undefined && (!Array.isArray(request.images) || request.images.length > 8 || request.images.some(id => !validPluginImageId(id))))) throw new Error("Invalid continuation request");
      request = structuredClone(request);
      await ensure();
      const receipt = await serial(async () => {
        const { record: r, owned } = await ownedRecord(request.conversationRequestId);
        const fingerprint = fingerprintOf(r.requestId, request.requestId, request.expectedInputRevision, request.prompt, request.images ?? [], request.displayText, request.fixedInstructions, request.codexServiceTier, request.deliveryMode);
        const previous = r.inputs.find(i => i.receipt.requestId === request.requestId);
        if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Continuation request fingerprint differs"); return structuredClone(previous.receipt); }
        if (request.codexServiceTier !== undefined && (r.sessionRef?.engine !== "codex" || await facade.codexServiceTierOverrideSupported?.() !== true)) throw new Error("Codex service tier override is unavailable for this coordinator");
        if (request.fixedInstructions && (!r.sessionRef || !supportsFixedInstructions(r.sessionRef.engine) || !await facade.fixedInstructionsSupported?.(r.sessionRef.engine))) throw new Error("Native fixed instructions are unavailable");
        if (r.inputRevision !== request.expectedInputRevision) throw new Error("Conversation input revision conflict");
        await prepareTimeline(r);
        if (deps.paused?.() || !(await project(r, owned)).canSend) throw new Error("Conversation cannot accept input in its current state");
        if (r.inputs.filter(pendingInput).length >= 32) throw new Error("Conversation pending input limit reached");
        const time = now();
        const receipt: HostTaskMessageReceipt = { conversationRequestId: r.requestId, requestId: request.requestId,
          ...(request.deliveryMode !== undefined ? { deliveryMode: request.deliveryMode } : {}),
          inputRevision: ++r.inputRevision, preview: preview(request.displayText), status: "queued", delivery: "queued", runId: null, sessionRef: r.sessionRef && { ...r.sessionRef }, acceptedAt: time, updatedAt: time };
        r.inputs.push({ receipt, fingerprint, prompt: request.prompt, images: [...(request.images ?? [])], ...(request.deliveryMode !== undefined ? { deliveryMode: request.deliveryMode } : {}), ...(request.displayText !== undefined ? { displayText: request.displayText } : {}), ...(request.fixedInstructions ? { fixedInstructions: fixedInstructionsIdentity(request.fixedInstructions) } : {}), ...(request.codexServiceTier !== undefined ? { codexServiceTier: request.codexServiceTier } : {}), ...(r.stopping ? { resumeStopEpoch: r.stopEpoch ?? 0 } : {}) });
        while (r.inputs.length > 128) { const at = r.inputs.findIndex(i => !pendingInput(i)); if (at < 0) break; r.inputs.splice(at, 1); }
        await deps.hold(r.requestId, true); await persist(); await project(r, owned); return structuredClone(receipt);
      });
      wake(); return receipt;
    },
    sendMessageNow: sendNow,
    async messageReceipt(id, requestId) { await ensure(); return serial(async () => { const { record } = await ownedRecord(id); await reconcile(record); await persist(); const input = record.inputs.find(i => i.receipt.requestId === requestId); return input ? receiptFor(record, input) : null; }); },
    async cancelMessage(id, requestId) { await ensure();
      if (records.get(id)?.inputs.some(i => i.receipt.requestId === requestId)) cancelledInputs.add(`${id}\u0000${requestId}`);
      return serial(async () => {
      const { record: r, owned } = await ownedRecord(id); const input = r.inputs.find(i => i.receipt.requestId === requestId);
      if (!input) return null;
      if (input.receipt.status === "queued") { if (r.prioritizedInput === requestId) r.prioritizedInput = undefined; input.receipt = { ...input.receipt, status: "cancelled", updatedAt: now(), error: undefined }; await persist(); await project(r, owned); }
      cancelledInputs.delete(`${id}\u0000${requestId}`); return structuredClone(input.receipt);
    }); },
    async stopConversation(id) { await ensure();
      const { record: r, owned } = await ownedRecord(id); r.stopping = true;
      r.prioritizedInput = undefined;
      stopErrors.delete(id);
      r.stopEpoch = (r.stopEpoch ?? 0) + 1;
      r.stopInputRevision = r.inputRevision;
      r.stopTerminalProof = undefined;
      for (const input of r.inputs) if (input.receipt.status === "queued") input.receipt = { ...input.receipt, status: "cancelled", updatedAt: now() };
      r.stopRunId = (r.sessionRef ? facade.conversationState?.(r.sessionRef)?.runId : owned.receipt.runId) ?? r.stopRunId;
      await persist();
      // Publish the durable stop fence before waiting for native interruption or
      // child retirement. The projection still requires real terminal proof.
      await project(r, owned);
      const errors: string[] = [];
      if (!r.sessionRef) { try { await deps.cancelInitial?.(id); } catch { errors.push("Initial task stop failed"); } }
      if (r.stopRunId) { try { assertOwner(); await facade.interrupt(r.stopRunId); } catch { errors.push("Coordinator stop failed"); } }
      errors.push(...await stopChildren(r, true));
      await reconcile(r); return project(r, owned, errors.length ? errors.join("; ") : undefined);
    },
    async conversationAction(id, action) { await ensure(); if (action?.type === "requestCostReview") return requestCostReview(id, action); return serial(async () => {
      const { record: r } = await ownedRecord(id); const view = await inspect(id);
      assertOwner();
      if (deps.paused?.()) throw new Error("Conversation actions are paused");
      if (!action || action.conversationRequestId !== id || !Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 1 ||
        (action.expectedRevision !== view.revision && action.type !== "dismissPrediction") || !r.sessionRef) throw new Error("Stale conversation action");
      if (action.type === "dismissPrediction") {
        if (!Number.isSafeInteger(action.predictionId) || action.predictionId < 1) throw new Error("Invalid prediction identity");
        // An unrelated streaming revision need not block dismissing the same
        // generation; a later generation must never be cleared by an old click.
        if (view.composerPrediction?.id === action.predictionId) facade.dismissComposerPrediction?.(r.sessionRef, action.predictionId);
        return inspect(id);
      }
      if (action.type === "openChild") {
        const child = view.children.find(c => c.id === action.childId); if (!child?.sessionRef) throw new Error("Owned native child is not available");
        await facade.focus(child.sessionRef);
      } else { if (!facade.conversationAction) throw new Error("Native conversation action unavailable"); await facade.conversationAction(r.sessionRef, action); }
      return inspect(id);
    }); },
    onConversationEvent(callback) { assertOwner(); if (typeof callback !== "function") throw new Error("Conversation callback required"); listeners.add(callback); void ensure().then(wake).catch(() => {}); return () => { listeners.delete(callback); }; },
    dispose() { disposed = true; off?.(); offEvents?.(); listeners.clear(); stopErrors.clear(); recoveryQueries.clear(); for (const query of terminalQueries.values()) clearTimeout(query.timer); terminalQueries.clear(); for (const id of lifecycleReads.keys()) discardLifecycle(id); for (const pending of timelinePreparations.values()) clearTimeout(pending.timer); timelinePreparations.clear(); unavailableTimelines.clear(); costContextReads = new WeakMap(); costContextQueue.clear(); costContextFlights.clear(); for (const { timer } of costRefreshTimers.values()) clearTimeout(timer); costRefreshTimers.clear(); },
  };

  async function stopChildren(r: RecordState, retry = false): Promise<string[]> {
    const errors: string[] = [];
    // Capture proof before issuing stop: a native stop may remove the row from
    // the next snapshot. Removal alone is not terminal proof.
    await children(r);
    for (const { branch: child, parent } of (await nativeChildren(r.sessionRef, r.children)).reverse()) if (!CHILD_TERMINAL.has(child.state)) {
      const key = `${r.requestId}\u0000${child.id}\u0000${child.runId ?? ""}`;
      if (!retry && stopRequests.has(key)) continue;
      stopRequests.add(key);
      try {
        assertOwner(); if (!facade.stopChild || !child.id) throw new Error();
        const proof = await facade.stopChild(parent, child.id);
        if (proof && proof.id === child.id && proof.runId === child.runId && proof.parentEngine === parent.engine && proof.parentSessionId === parent.sessionId &&
          sameTaskPath(proof.parentWorkspacePath ?? proof.workspacePath, parent.workspacePath) && CHILD_TERMINAL.has(proof.state)) {
          r.children = r.children?.map(c => c.id === child.id ? { ...c, state: proof.state } : c);
          await persist();
        }
      } catch { errors.push(`Child stop could not be confirmed: ${child.id}`); }
    }
    return errors;
  }
}
