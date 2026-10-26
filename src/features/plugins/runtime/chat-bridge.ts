import type { Disposer, HostChatIdentity, HostChatTarget, HostChatSession, HostChatSubmission, HostChatReceipt, PluginContext } from "@ccgui/plugin-sdk";
import { listenEngineEvents, type EngineEventPayload } from "@/lib/events";
import { newId } from "@/lib/id";
import { isWeb } from "@/lib/transport";
import { HostChatBusyError } from "@/features/chat/store/types";
import { crossSessionCostReview, requiresCrossSessionCostApproval } from "@/features/chat/cross-session-cost";
import { resolveSessionModel } from "@/features/chat/store/stream";
import { cloneCheckpointValue, runtimeCheckpoint, type RuntimeCheckpoint, type RuntimeCheckpointParticipant } from "@/lib/runtime-checkpoint";
import type { PluginStorageBackend } from "./context";
import {
  INBOX_GUIDANCE, MAX_INBOX_TEXT, MAX_INBOX_RESPONSE_BYTES, MAX_RELATED_MESSAGE_BYTES, acknowledgementCopy, callerCopy, envelopeCopy,
  readOptionsCopy, renderInboxTurn, sameParticipant, targetParticipant, validCorrespondenceId, validMessageId,
  type CorrespondenceEnvelope, type CorrespondenceReceipt, type InboxAcknowledgement, type InboxCaller,
  type InboxClaim, type InboxMessage, type InboxParticipant, type InboxRead, type InboxReadOptions,
  type InboxReadResult, type InboxSummary, type InboxWaitReason,
} from "./chat-inbox";

/** A request the user chose to send ahead of the target's own queued rows. */
export interface HostChatDeliveryOptions { priority?: boolean }

/** Host-only seam: plugins see only the SDK facade, never the store. */
export interface HostChatFacade {
  current(): HostChatSession | null;
  inspect(target: HostChatTarget, options?: HostChatDeliveryOptions): HostChatSession | null;
  model?(target: HostChatTarget): string | undefined;
  requiresCostApproval?(target: HostChatTarget): Promise<boolean> | boolean;
  send(target: HostChatTarget, prompt: string, runId: string, options?: HostChatDeliveryOptions): Promise<{ runId: string; sessionId: string | null }>;
  subscribe(callback: () => void): Disposer;
  ready?(): Promise<void>;
  wasInterrupted(target: HostChatTarget): boolean;
  identity: HostChatIdentity;
}

export const HOST_CHAT_LEDGER_KEY = "__host_chat_requests_v1";
/** A document owns its durable ledger. Simultaneous desktop windows using the
 * same plugin cannot overwrite one another through the KV's get/set API.
 * A new document never loads/replays an old pinned source's records. */
export function hostChatLedgerKey(identity: HostChatFacade["identity"]): string {
  return `${HOST_CHAT_LEDGER_KEY}:${JSON.stringify([identity.clientInstanceId, identity.windowId])}`;
}
const MAX_TEXT = 65_536;
const MAX_REQUESTS = 512; // Never evict idempotency keys silently.
const terminal = new Set(["completed", "failed", "unknown"]);
const statuses = new Set(["queued", "received", "executing", "awaiting_permission", "awaiting_cost_approval", ...terminal]);
const interruptedResult: Partial<HostChatReceipt> = { status: "failed", error: "Original GUI turn was interrupted" };
const reservations = new Set<string>();
let desktopIdentity: HostChatFacade["identity"] | undefined;

function identityCopy(value: unknown): HostChatIdentity {
  const identity = value as HostChatIdentity | null;
  if (!identity || [identity.clientInstanceId, identity.windowId]
    .some((part) => typeof part !== "string" || !part.trim() || part.length > 4096)) {
    throw new Error("Invalid host chat checkpoint identity");
  }
  return { clientInstanceId: identity.clientInstanceId, windowId: identity.windowId };
}

const unregisterIdentityCheckpoint = runtimeCheckpoint.register({
  id: "host-chat-identity",
  capture: () => ({ version: 1, identity: desktopIdentity ? identityCopy(desktopIdentity) : null }),
  restore(value) {
    const snapshot = cloneCheckpointValue(value) as { version?: unknown; identity?: unknown };
    if (!snapshot || snapshot.version !== 1 || !Object.hasOwn(snapshot, "identity")) throw new Error("Invalid host chat identity checkpoint");
    desktopIdentity = snapshot.identity === null ? undefined : identityCopy(snapshot.identity);
  },
});
if (import.meta.hot) import.meta.hot.dispose(unregisterIdentityCheckpoint);

/** A lazy plugin bridge must be prewarmed before handoff resume. The coordinator
 * deliberately keeps its checkpoint pending until this exact ID registers. */
export function hostChatCheckpointId(pluginId: string): string {
  return `host-chat-bridge:${encodeURIComponent(pluginId)}`;
}

export function pendingHostChatPluginIds(checkpoint: RuntimeCheckpoint): string[] {
  const ids: string[] = [];
  for (const [id, value] of Object.entries(checkpoint.participants)) {
    if (!id.startsWith("host-chat-bridge:")) continue;
    const pluginId = (value as { pluginId?: unknown } | null)?.pluginId;
    if (typeof pluginId !== "string" || !pluginId || hostChatCheckpointId(pluginId) !== id) throw new Error("Invalid host chat bridge checkpoint participant");
    if (pluginId !== "ccgui-cross-session") ids.push(pluginId);
  }
  return ids;
}

function targetCopy(target: HostChatTarget): HostChatTarget {
  if (!target || target.client !== "ccgui" ||
    [target.engine, target.nativeSessionId, target.guiSessionId, target.workspacePath, target.clientInstanceId, target.windowId]
      .some((v) => typeof v !== "string" || !v.trim() || v.length > 4096) ||
    target.nativeSessionId !== target.guiSessionId ||
    (target.engine === "claude" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.nativeSessionId))) {
    throw new Error("Invalid exact host chat target");
  }
  return { client: "ccgui", engine: target.engine, nativeSessionId: target.nativeSessionId,
    guiSessionId: target.guiSessionId, workspacePath: target.workspacePath,
    clientInstanceId: target.clientInstanceId, windowId: target.windowId };
}
function targetKey(target: HostChatTarget): string { return JSON.stringify(targetCopy(target)); }
function copy(receipt: CorrespondenceReceipt): CorrespondenceReceipt { return { ...receipt, target: { ...receipt.target }, ...(receipt.mailbox ? { mailbox: { ...receipt.mailbox } } : {}) }; }
function clip(text: string, limit: number): string {
  const prefix = text.slice(0, limit);
  // Do not end a bounded prefix in half of an emoji/non-BMP code point.
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/** Existing open, loaded conversations only: opening history is a separate,
 * explicit host action. Closed/unloaded targets cannot inherit global defaults. */
export async function desktopChatFacade(): Promise<HostChatFacade> {
  if (isWeb) throw new Error("host:chat is available only in the desktop host");
  desktopIdentity ??= { clientInstanceId: `ccgui-${newId()}`, windowId: `window-${newId()}` };
  const identity = desktopIdentity;
  const { useChatStore, sessionKey } = await import("@/features/chat/store");
  const inspect = (target: HostChatTarget, options?: HostChatDeliveryOptions): HostChatSession | null => {
    if (target.clientInstanceId !== identity.clientInstanceId || target.windowId !== identity.windowId) return null;
    const state = useChatStore.getState();
    const tab = state.openTabs.find((t) => t.engine === target.engine && t.sessionId === target.nativeSessionId && t.workspacePath === target.workspacePath);
    const key = sessionKey(target.engine, target.nativeSessionId, target.workspacePath);
    const session = state.bySession[key];
    if (!state.initialized || !tab || !session || session.loading || state.archivedSessionKeys[key]) return null;
    const awaiting = session.messages.some((m) => m.question?.status === "pending" || m.grant?.status === "pending" ||
      m.planReview?.status === "awaiting_review" || m.planReview?.status === "deferred" || m.planReview?.status === "submitting");
    // A prioritized request goes ahead of the composer's queued rows; it still
    // never overlaps a running turn or an open approval.
    const queued = !options?.priority && session.queue.length > 0;
    return { ...target, status: awaiting ? "awaiting_permission" : session.streaming || queued ? "busy" : "idle" };
  };
  return {
    identity,
    inspect,
    model(target) {
      const state = useChatStore.getState();
      const tab = state.openTabs.find((t) => t.engine === target.engine && t.sessionId === target.nativeSessionId && t.workspacePath === target.workspacePath);
      if (!tab || !inspect(target)) return undefined;
      return resolveSessionModel(tab, state.bySession[sessionKey(target.engine, target.nativeSessionId, target.workspacePath)], state.models[target.engine]);
    },
    async requiresCostApproval(target) {
      const session = inspect(target);
      if (!session) return true;
      const { ipc } = await import("@/lib/ipc");
      const fresh = await ipc.listSessions().catch(() => null);
      const state = useChatStore.getState();
      const catalogMeta = fresh?.find((s) => s.engine === target.engine && s.sessionId === target.nativeSessionId && s.workspacePath === target.workspacePath);
      const stateMeta = state.sessions?.find((s) => s.engine === target.engine && s.sessionId === target.nativeSessionId && s.workspacePath === target.workspacePath);
      const meta = !stateMeta ? catalogMeta : !catalogMeta ? stateMeta : !catalogMeta.promptCache ? { ...stateMeta, promptCache: null }
        : !stateMeta.promptCache || catalogMeta.promptCache.observedAt >= stateMeta.promptCache.observedAt
          ? { ...stateMeta, promptCache: catalogMeta.promptCache } : stateMeta;
      if (!meta) return true;
      const review = crossSessionCostReview(meta, state, session.status);
      return requiresCrossSessionCostApproval(review);
    },
    current() {
      const active = useChatStore.getState().active;
      if (!active?.sessionId) return null;
      try { return inspect(targetCopy({ client: "ccgui", engine: active.engine, nativeSessionId: active.sessionId,
        guiSessionId: active.sessionId, workspacePath: active.workspacePath, ...identity })); }
      catch { return null; }
    },
    async send(target, prompt, runId, options) {
      const session = inspect(target, options);
      if (!session) throw new Error("Exact host chat target is no longer reachable");
      if (session.status !== "idle") throw new HostChatBusyError();
      const tab = useChatStore.getState().openTabs.find((t) => t.engine === target.engine && t.sessionId === target.nativeSessionId && t.workspacePath === target.workspacePath)!;
      let started: { runId: string; sessionId: string | null } | undefined;
      await useChatStore.getState().send(prompt, [], { requestedRunId: runId, onRunStarted: (result) => { started = result; } }, tab);
      if (!started) throw new Error("Native host chat spawn acknowledgement is unavailable");
      return started;
    },
    subscribe: (cb) => useChatStore.subscribe(cb),
    wasInterrupted: (target) => useChatStore.getState().bySession[sessionKey(target.engine, target.nativeSessionId, target.workspacePath)]?.interrupted === true,
  };
}

interface Entry { receipt: CorrespondenceReceipt; prompt: string; fingerprint: string; lastSeq: number; priority?: true; costGuard?: true; costReviewedModel?: string | null;
  envelope?: CorrespondenceEnvelope; claim?: InboxClaim; acknowledgement?: InboxAcknowledgement }
interface Ledger { version: 1; entries: Entry[]; inboxReads?: InboxRead[] }
interface BridgeCheckpoint {
  version: 1;
  pluginId: string;
  identity: HostChatIdentity;
  ledger: Ledger;
  pendingStarts: Array<[string, HostChatReceipt["status"]]>;
  acknowledgedRuns: string[];
  sessionProvenRuns: string[];
  pendingTerminals: Array<[string, Partial<HostChatReceipt>]>;
  endedInboxRuns?: string[];
  fenced: boolean;
}
type CheckpointCoordinator = Pick<typeof runtimeCheckpoint, "register" | "isPaused" | "assertAllowed">;
interface RestoringBridge { snapshot: BridgeCheckpoint; owner: symbol; drain: Promise<void> }
const restoringBridges = new WeakMap<CheckpointCoordinator, Map<string, RestoringBridge>>();
function restorationCache(coordinator: CheckpointCoordinator): Map<string, RestoringBridge> {
  let cache = restoringBridges.get(coordinator);
  if (!cache) { cache = new Map(); restoringBridges.set(coordinator, cache); }
  return cache;
}

function ledgerEntries(value: unknown, identity?: HostChatIdentity): Entry[] {
  const ledger = value as Ledger | null;
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.entries) || ledger.entries.length > MAX_REQUESTS) throw new Error("Invalid host chat request ledger");
  const requests = new Set<string>();
  const runs = new Set<string>();
  return ledger.entries.map((value) => {
    const target = targetCopy(value?.receipt?.target);
    if (!validRequestId(value.receipt?.requestId) || typeof value.prompt !== "string" || value.prompt.length > 131_072 ||
      !statuses.has(value.receipt.status) || typeof value.receipt.runId !== "string" || !value.receipt.runId.startsWith("run-") ||
      !Number.isFinite(value.receipt.acceptedAt) || !Number.isFinite(value.receipt.updatedAt) || !Number.isInteger(value.lastSeq) || value.lastSeq < -1 ||
      (value.priority !== undefined && value.priority !== true) ||
      (value.costGuard !== undefined && value.costGuard !== true) ||
      (value.costReviewedModel !== undefined && value.costReviewedModel !== null && typeof value.costReviewedModel !== "string") ||
      value.fingerprint !== JSON.stringify([target, value.prompt]) || requests.has(value.receipt.requestId) ||
      (value.receipt.text !== undefined && typeof value.receipt.text !== "string") ||
      (value.receipt.error !== undefined && typeof value.receipt.error !== "string") ||
      (identity && (target.clientInstanceId !== identity.clientInstanceId || target.windowId !== identity.windowId || runs.has(value.receipt.runId)))) {
      throw new Error("Invalid host chat request ledger");
    }
    requests.add(value.receipt.requestId); runs.add(value.receipt.runId);
    const entry = structuredClone(value);
    entry.receipt = { ...entry.receipt, target, text: entry.receipt.text === undefined ? undefined : clip(entry.receipt.text, MAX_TEXT),
      truncated: entry.receipt.truncated === true || (entry.receipt.text?.length ?? 0) > MAX_TEXT,
      error: entry.receipt.error === undefined ? undefined : clip(entry.receipt.error, 1024) };
    if (entry.envelope) entry.envelope = envelopeCopy(entry.envelope);
    const mailbox = entry.receipt.mailbox;
    if (mailbox && (!entry.envelope?.relation || !["received", "retrieved", "handled", "deferred", "uncertain"].includes(mailbox.phase) ||
      mailbox.relation !== entry.envelope.relation.type || mailbox.parentRequestId !== entry.envelope.relation.requestId || mailbox.kind !== entry.envelope.kind ||
      (mailbox.waitReason !== undefined && !["target_busy", "permission", "cost_approval", "stopped", "parent_pending", "target_unavailable", "processing_unconfirmed"].includes(mailbox.waitReason)) ||
      [mailbox.retrievedAt, mailbox.handledAt].some(at => at !== undefined && !Number.isFinite(at)) ||
      (mailbox.impactReview !== undefined && (typeof mailbox.impactReview !== "string" || [...mailbox.impactReview].length > 8000)))) throw new Error("Invalid inbox receipt ledger");
    if (entry.envelope?.relation && !mailbox) throw new Error("Missing inbox receipt ledger");
    if (entry.claim && (typeof entry.claim.runId !== "string" || !entry.claim.runId || !validCorrespondenceId(entry.claim.readRequestId) ||
      !["tool", "turn"].includes(entry.claim.mode) || !Number.isFinite(entry.claim.at) || typeof entry.claim.review !== "boolean" || !mailbox)) throw new Error("Invalid inbox claim ledger");
    if (mailbox && ["retrieved", "handled", "deferred"].includes(mailbox.phase) && !entry.claim) throw new Error("Inbox receipt has no retrieval proof");
    if (entry.acknowledgement) {
      const ack = acknowledgementCopy(entry.acknowledgement, entry.acknowledgement.runId);
      if (!entry.claim || ack.runId !== entry.claim.runId || ack.readRequestId !== entry.claim.readRequestId ||
        (mailbox?.kind === "correction" && ack.outcome === "handled" && !ack.impactReview)) throw new Error("Invalid inbox acknowledgement ledger");
    }
    return entry;
  });
}
function ledgerInboxReads(value: Ledger, entries: Map<string, Entry>): InboxRead[] {
  const reads = value.inboxReads ?? [];
  if (!Array.isArray(reads) || reads.length > MAX_REQUESTS) throw new Error("Invalid inbox read ledger");
  const keys = new Set<string>();
  return reads.map(read => {
    const caller = callerCopy(read?.caller), key = JSON.stringify([caller, read.requestId]);
    if (!validCorrespondenceId(read.requestId) || keys.has(key) || typeof read.fingerprint !== "string" || !Array.isArray(read.messageIds) || read.messageIds.length > 8 ||
      new Set(read.messageIds).size !== read.messageIds.length || read.messageIds.some(id => !validMessageId(id) || !entries.get(id)?.receipt.mailbox || !sameParticipant(caller, targetParticipant(entries.get(id)!.receipt.target))) ||
      (read.reviewIds !== undefined && (!Array.isArray(read.reviewIds) || read.reviewIds.some(id => !read.messageIds.includes(id))))) throw new Error("Invalid inbox read ledger");
    keys.add(key); return structuredClone({ ...read, caller });
  });
}
interface CorrespondenceCostOptions { requiresCostApproval?: boolean; costGuard?: boolean; reviewedModel?: string | null; checkCost?: () => Promise<boolean> | boolean }
export interface HostChatBridgeDependencies {
  host?: () => Promise<HostChatFacade>;
  listen?: (callback: (events: EngineEventPayload[]) => void) => Promise<Disposer>;
  now?: () => number;
  runId?: () => string;
  checkpoint?: CheckpointCoordinator;
  /** Extra owner readiness, e.g. the native host-chat subscription ACK. */
  checkpointReady?: () => Promise<void>;
  /** Native host readiness follows restored bridge state, never precedes it. */
  resumed?: () => void;
}

/** Persist-before-ack and persist-before-spawn fencing. A storage/transport
 * ambiguity stops automatic execution; this deliberately makes no exactly-once
 * claim. Serial ledger updates also isolate concurrent duplicate submissions. */
export function createHostChatBridge(pluginId: string, storage: PluginStorageBackend, deps: HostChatBridgeDependencies = {}):
  PluginContext["chat"] & {
    dispose: Disposer;
    ready(): Promise<void>;
    submitForCostApproval(request: HostChatSubmission): Promise<HostChatReceipt>;
    submitWithCostGuard(request: HostChatSubmission, reviewedModel?: string | null, requiresCostApproval?: () => Promise<boolean> | boolean): Promise<HostChatReceipt>;
    approveCost(requestId: string, reviewedModel?: string | null): Promise<HostChatReceipt | null>;
    prioritize(requestId: string): Promise<HostChatReceipt | null>;
    cancel(requestId: string): Promise<HostChatReceipt | null>;
    submitCorrespondence(request: HostChatSubmission, envelope: CorrespondenceEnvelope, cost?: CorrespondenceCostOptions): Promise<CorrespondenceReceipt>;
    findCorrespondence(caller: InboxCaller, requestId: string): Promise<CorrespondenceReceipt | null>;
    inboxStatus(caller: InboxCaller): Promise<InboxSummary>;
    readMessages(caller: InboxCaller, options: InboxReadOptions): Promise<InboxReadResult>;
    acknowledgeMessage(caller: InboxCaller, messageId: string, acknowledgement: Omit<InboxAcknowledgement, "runId">): Promise<CorrespondenceReceipt>;
  } {
  const now = deps.now ?? Date.now;
  const checkpoint = deps.checkpoint ?? runtimeCheckpoint;
  const participantId = hostChatCheckpointId(pluginId);
  const checkpointOwner = Symbol(participantId);
  let predecessorDrain: Promise<void> = Promise.resolve();
  const entries = new Map<string, Entry>();
  const inboxReads = new Map<string, InboxRead>();
  const endedInboxRuns = new Set<string>();
  const inboxRunKey = (engine: string, sessionId: string, runId: string) => JSON.stringify([engine, sessionId, runId]);
  const inboxRunEnded = (caller: InboxCaller) => endedInboxRuns.has(inboxRunKey(caller.engine, caller.sessionId, caller.runId));
  // Native events may finish before invoke resolves. Do not publish an
  // externally terminal receipt until the spawn ACK attests the frozen IDs.
  const acknowledgedRuns = new Set<string>();
  // Child-spawn ACKs (including resumed Claude) legitimately omit sessionId.
  // The reader's native session announcement/envelope supplies that proof;
  // never manufacture it from the requested target or current conversation.
  const sessionProvenRuns = new Set<string>();
  const pendingTerminals = new Map<string, Partial<HostChatReceipt>>();
  // The durable may-have-started fence is not public proof of a native start.
  const pendingStarts = new Map<string, HostChatReceipt["status"]>();
  const costGuards = new Map<string, () => Promise<boolean> | boolean>();
  const inFlightStarts = new Set<string>();
  const listeners = new Set<(receipt: HostChatReceipt) => void>();
  const disposers: Disposer[] = [];
  let host: HostChatFacade;
  let ledgerKey: string;
  let init: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let fenced = false;
  let kicking = false;
  let wakeRequested = false;
  let restored = false;
  let restoredIdentity: HostChatIdentity | undefined;
  let initializationFailure: unknown;
  let unregisterCheckpoint: Disposer = () => {};

  const assertOwner = () => { if (disposed) throw new Error("Host chat bridge has been disposed"); };

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn);
    chain = result.catch(() => undefined);
    return result;
  };
  const visible = (receipt: CorrespondenceReceipt) => {
    const ack = entries.get(receipt.requestId)?.acknowledgement;
    // A message receipt can be sealed while the native turn still owns other
    // messages. Keep its execution status/output separate from that receipt.
    return copy(ack && receipt.mailbox?.phase === ack.outcome ? { ...receipt,
      status: ack.outcome === "handled" ? "completed" : "unknown", text: ack.response === undefined ? undefined : clip(ack.response, MAX_TEXT),
      truncated: (ack.response?.length ?? 0) > MAX_TEXT,
      error: ack.outcome === "handled" ? undefined : "The recipient deferred this message; it will not be automatically replayed",
    } : { ...receipt, status: pendingStarts.get(receipt.runId) ?? receipt.status });
  };
  const emit = (receipt: HostChatReceipt) => {
    if (disposed) return;
    for (const cb of [...listeners]) {
      try { cb(visible(receipt)); } catch { console.error("[plugins] host chat receipt listener failed"); }
    }
  };
  const persist = () => {
    assertOwner();
    return storage.set(pluginId, ledgerKey, structuredClone({ version: 1, entries: [...entries.values()], inboxReads: [...inboxReads.values()] } satisfies Ledger));
  };
  const clearTerminal = (entry: Entry) => {
    if (!terminal.has(entry.receipt.status)) return;
    acknowledgedRuns.delete(entry.receipt.runId);
    sessionProvenRuns.delete(entry.receipt.runId);
    pendingTerminals.delete(entry.receipt.runId);
    pendingStarts.delete(entry.receipt.runId);
    costGuards.delete(entry.receipt.requestId);
  };
  const evaluateCostGuard = async (requestId: string, target: HostChatTarget): Promise<boolean> => {
    const check = costGuards.get(requestId);
    if (check) return (await check()) === true;
    return (await host.requiresCostApproval?.(target)) === true;
  };
  const ownsNativeRun = (entry: Entry) => !entry.claim || entry.claim.runId === entry.receipt.runId;
  const stopReason = (entry: Entry): boolean => {
    const parent = entry.envelope?.relation && entries.get(entry.envelope.relation.scopedId);
    return host.wasInterrupted(entry.receipt.target) || !!(parent && parent.receipt.status === "failed" && /interrupted|cancelled/i.test(parent.receipt.error ?? ""));
  };
  function associatedForRun(entry: Entry): Entry[] {
    if (!terminal.has(entry.receipt.status)) return [];
    const changed: Entry[] = [];
    for (const other of entries.values()) {
      if (other.claim?.mode !== "turn" || other.claim.runId !== entry.receipt.runId || !other.receipt.mailbox ||
        !sameParticipant(targetParticipant(other.receipt.target), targetParticipant(entry.receipt.target)) ||
        ["handled", "deferred", "uncertain"].includes(other.receipt.mailbox.phase)) continue;
      const completed = entry.receipt.status === "completed" && other.receipt.mailbox.kind !== "correction";
      other.receipt = { ...other.receipt, status: completed ? "completed" : "unknown", updatedAt: now(),
        ...(completed ? { text: entry.receipt.text, truncated: entry.receipt.truncated, error: undefined } : { error: other.receipt.mailbox.kind === "correction" && entry.receipt.status === "completed"
          ? "Correction was delivered but its impact review was not acknowledged; reconcile before continuing"
          : "Associated message delivery may have started; reconcile the original identity before any retry" }),
        mailbox: { ...other.receipt.mailbox, phase: completed ? "handled" : "uncertain", waitReason: completed ? undefined : "processing_unconfirmed", ...(completed ? { handledAt: now() } : {}) } };
      changed.push(other);
    }
    return changed;
  }
  const shouldHoldForCost = async (entry: Entry): Promise<boolean> => {
    const { target, requestId } = entry.receipt;
    if (entry.costReviewedModel !== undefined && entry.costReviewedModel !== (host.model?.(target) ?? null)) {
      return true;
    }
    if (!entry.costGuard) return false;
    return evaluateCostGuard(requestId, target);
  };
  const change = async (entry: Entry, patch: Partial<CorrespondenceReceipt>, settleAssociated = true) => {
    if (disposed) return;
    entry.receipt = { ...entry.receipt, ...patch, updatedAt: now() };
    const changed = new Set([entry, ...(settleAssociated ? associatedForRun(entry) : [])]);
    try { await persist(); }
    catch {
      fenced = true;
      for (const item of changed) item.receipt = { ...item.receipt, status: "unknown", error: "Host chat ledger update failed; execution will not be replayed", updatedAt: now(),
        ...(item.receipt.mailbox ? { mailbox: { ...item.receipt.mailbox, phase: "uncertain", waitReason: "processing_unconfirmed" } } : {}) };
      for (const item of associatedForRun(entry)) changed.add(item);
    }
    for (const item of changed) { clearTerminal(item); emit(item.receipt); }
  };
  const ensure = () => init ??= (async () => {
    assertOwner();
    host = await (deps.host ?? desktopChatFacade)();
    assertOwner();
    if (restoredIdentity && (host.identity.clientInstanceId !== restoredIdentity.clientInstanceId || host.identity.windowId !== restoredIdentity.windowId)) {
      throw new Error("Host chat checkpoint belongs to another desktop document");
    }
    ledgerKey = hostChatLedgerKey(host.identity);
    const off = await (deps.listen ?? listenEngineEvents)((events) => {
      // Record closure before queuing ledger work: a read may currently be
      // awaiting initialization, a cost probe, or a durable write on that chain.
      for (const event of events) if (["done", "error", "turn_complete"].includes(event.kind) && event.sessionId && Number.isInteger(event.seq)) {
        endedInboxRuns.add(inboxRunKey(event.engine, event.sessionId, event.runId));
        if (endedInboxRuns.size > 8192) endedInboxRuns.delete(endedInboxRuns.values().next().value!);
      }
      void serial(async () => { await ensure(); if (!disposed) await onEvents(events); });
    });
    if (disposed) { off(); throw new Error("Host chat bridge has been disposed"); }
    disposers.push(off);
    disposers.push(host.subscribe(() => kick()));
    await host.ready?.();
    assertOwner();
    await predecessorDrain;
    assertOwner();
    const loaded = restored ? null : await storage.get(pluginId, ledgerKey) as Ledger | null;
    // An old document/bridge can be disposed while its async KV read is still
    // resolving. Its result must never overwrite a restored owner's ledger.
    assertOwner();
    if (!restored && loaded) {
      for (const entry of ledgerEntries(loaded)) {
        if (!terminal.has(entry.receipt.status)) {
          entry.receipt = { ...entry.receipt, status: "unknown", updatedAt: now(), error: "Restored nonterminal request has uncertain acceptance or execution; not replayed" };
          if (entry.receipt.mailbox && !entry.acknowledgement) entry.receipt.mailbox = { ...entry.receipt.mailbox, phase: "uncertain", waitReason: "processing_unconfirmed" };
        }
        entries.set(entry.receipt.requestId, entry);
      }
      for (const read of ledgerInboxReads(loaded, entries)) inboxReads.set(JSON.stringify([read.caller, read.requestId]), read);
    }
    if (restored) {
      for (const entry of entries.values()) {
        const completion = pendingTerminals.get(entry.receipt.runId);
        if (completion && acknowledgedRuns.has(entry.receipt.runId) && sessionProvenRuns.has(entry.receipt.runId)) {
          entry.receipt = { ...entry.receipt, ...completion, updatedAt: now() };
          clearTerminal(entry);
          for (const related of associatedForRun(entry)) clearTerminal(related);
        }
      }
    }
    if (loaded || restored) await persist();
    assertOwner();
    for (const entry of entries.values()) emit(entry.receipt);
    kick();
  })().catch((error: unknown) => { initializationFailure = error; throw error; });

  async function ready() {
    await ensure();
    for (;;) {
      const observed = chain;
      await observed;
      assertOwner();
      if (observed === chain) break;
    }
  }

  function waitingReason(entry: Entry): InboxWaitReason | undefined {
    if (!entry.receipt.mailbox || entry.receipt.mailbox.phase !== "received") return entry.receipt.mailbox?.phase === "handled" ? undefined : "processing_unconfirmed";
    if (entry.receipt.status === "awaiting_cost_approval") return "cost_approval";
    if (!entry.priority && stopReason(entry)) return "stopped";
    const parent = entry.envelope?.relation && entries.get(entry.envelope.relation.scopedId);
    if (entry.envelope?.relation?.type === "update" && parent && ["queued", "received", "awaiting_cost_approval"].includes(parent.receipt.status)) return "parent_pending";
    const session = host.inspect(entry.receipt.target);
    return !session ? "target_unavailable" : session.status === "awaiting_permission" ? "permission" : session.status === "busy" ? "target_busy" : undefined;
  }
  function inboxSummary(caller: InboxParticipant): InboxSummary {
    let pending = 0, held = 0, needsReconciliation = 0;
    for (const entry of entries.values()) {
      const mailbox = entry.receipt.mailbox;
      if (!mailbox || !sameParticipant(caller, targetParticipant(entry.receipt.target)) || mailbox.phase === "handled" || entry.receipt.status === "failed") continue;
      if (mailbox.phase !== "received") { needsReconciliation++; continue; }
      const reason = waitingReason(entry);
      if (!reason || reason === "target_busy") pending++; else held++;
    }
    // Only current nonterminal dependencies form a wait cycle, not an ordinary
    // historical exchange. This is metadata, never a claim or peer instruction.
    const outgoing = [...entries.values()].filter(entry => entry.envelope && !terminal.has(entry.receipt.status) && sameParticipant(entry.envelope.sender, caller));
    const waitingOnCaller = [...entries.values()].filter(entry => entry.envelope && !entry.envelope.relation &&
      ["queued", "received"].includes(entry.receipt.status) && sameParticipant(caller, targetParticipant(entry.receipt.target)) &&
      outgoing.some(sent => sameParticipant(targetParticipant(sent.receipt.target), entry.envelope!.sender)))
      .slice(0, 8).map(entry => ({ messageId: entry.receipt.requestId, sender: { ...entry.envelope!.sender }, requestId: entry.envelope!.requestId }));
    return { pending, held, needsReconciliation, ...(waitingOnCaller.length ? { waitingOnCaller } : {}),
      ...(pending || needsReconciliation || waitingOnCaller.length ? { nextAction: pending
        ? "Call read_messages with a new stable request_id to retrieve your associated inbox before waiting or finishing. This notice contains no message body and does not acknowledge processing."
        : waitingOnCaller.length ? "The other assistant may be waiting on this chat while this chat waits on it. Do not spin indefinitely: use an explicit reply_to/update_of for related information, or finish the current turn so independent questions can proceed."
          : "Previously retrieved messages need an explicit processing receipt. Inspect their original outcome; use read_messages with explicit message_ids for reconciliation, never blindly repeat actions." } : {}) };
  }
  function inboxMessage(entry: Entry, readRequestId: string, review: boolean): InboxMessage {
    const envelope = entry.envelope!;
    return { message_id: entry.receipt.requestId, request_id: envelope.requestId, sender: { ...envelope.sender },
      relation: { type: envelope.relation!.type, request_id: envelope.relation!.requestId }, message_kind: envelope.kind ?? "information",
      message: entry.prompt, read_request_id: readRequestId, needs_reconciliation: review, processing_state: entry.receipt.mailbox!.phase };
  }
  function claimMessage(entry: Entry, runId: string, readRequestId: string, mode: InboxClaim["mode"], review = false) {
    entry.claim = { runId, readRequestId, mode, at: now(), review };
    delete entry.acknowledgement;
    entry.receipt = { ...entry.receipt, status: "executing", updatedAt: now(), error: undefined,
      mailbox: { ...entry.receipt.mailbox!, phase: "retrieved", retrievedAt: now(), waitReason: "processing_unconfirmed" } };
  }
  function turnPrompt(entry: Entry, messages: InboxMessage[]) {
    const base = entry.receipt.mailbox ? "Handle the following associated messages in the existing conversation. Continue from established context; do not replay or restart the original request." : entry.prompt;
    return renderInboxTurn(base, entry.envelope, messages);
  }
  async function readMessages(rawCaller: InboxCaller, rawOptions: InboxReadOptions): Promise<InboxReadResult> {
    const caller = callerCopy(rawCaller), options = readOptionsCopy(rawOptions);
    await ensure();
    return serial(async () => {
      assertOwner(); checkpoint.assertAllowed();
      if (fenced) throw new Error("Host chat ledger is fenced after an ambiguous storage failure");
      const key = JSON.stringify([caller, options.requestId]), fingerprint = JSON.stringify([options.limit, options.messageIds ?? null]);
      const previous = inboxReads.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Inbox read request_id already belongs to a different selection");
        return { read_request_id: options.requestId, messages: previous.messageIds.map(id => inboxMessage(entries.get(id)!, options.requestId, previous.reviewIds?.includes(id) === true)), inbox: inboxSummary(caller), instructions: INBOX_GUIDANCE };
      }
      if (inboxReads.size >= MAX_REQUESTS) throw new Error("Inbox retrieval ledger capacity reached");
      const explicit = options.messageIds !== undefined;
      const candidates = inboxRunEnded(caller) ? [] : explicit ? options.messageIds!.map(id => {
        const entry = entries.get(id);
        if (!entry?.receipt.mailbox || !sameParticipant(caller, targetParticipant(entry.receipt.target))) throw new Error("Message does not belong to the caller's inbox");
        if (entry.receipt.mailbox.phase === "retrieved" && entry.claim?.runId !== caller.runId) throw new Error("Message belongs to another active retrieval; reconcile after that turn settles");
        return entry;
      }) : [...entries.values()].filter(entry => entry.receipt.mailbox?.phase === "received" && sameParticipant(caller, targetParticipant(entry.receipt.target)));
      const selected: Entry[] = [], reviewIds: string[] = []; let size = 0;
      for (const entry of candidates) {
        if (selected.length >= options.limit) break;
        if (entry.receipt.status === "failed" || entry.receipt.mailbox!.phase === "handled") continue;
        const reason = waitingReason(entry);
        const session = host.inspect(entry.receipt.target);
        if (!session || session.status === "awaiting_permission" || entry.receipt.status === "awaiting_cost_approval" || reason === "permission" || reason === "target_unavailable" ||
          (!explicit && reason && reason !== "target_busy")) continue;
        if (await shouldHoldForCost(entry)) { await change(entry, { status: "awaiting_cost_approval", mailbox: { ...entry.receipt.mailbox!, waitReason: "cost_approval" } }); continue; }
        assertOwner(); checkpoint.assertAllowed();
        if (fenced) throw new Error("Inbox delivery is fenced");
        // The cost probe may yield. Recheck target state before exposing bytes.
        const latest = waitingReason(entry);
        const currentSession = host.inspect(entry.receipt.target);
        if (!currentSession || currentSession.status === "awaiting_permission" || latest === "permission" || latest === "target_unavailable" || (!explicit && latest && latest !== "target_busy")) continue;
        const prospective = [...selected, entry].map(item => inboxMessage(item, options.requestId, true));
        if (size + entry.prompt.length > MAX_INBOX_TEXT || new TextEncoder().encode(JSON.stringify(prospective)).length > MAX_INBOX_RESPONSE_BYTES) break;
        size += entry.prompt.length;
        if (entry.receipt.mailbox!.phase !== "received" || (explicit && stopReason(entry))) reviewIds.push(entry.receipt.requestId);
        selected.push(entry);
      }
      if (inboxRunEnded(caller)) { selected.length = 0; reviewIds.length = 0; }
      const read: InboxRead = { caller, requestId: options.requestId, fingerprint, messageIds: selected.map(entry => entry.receipt.requestId), reviewIds };
      for (const entry of selected) claimMessage(entry, caller.runId, options.requestId, "tool", reviewIds.includes(entry.receipt.requestId));
      inboxReads.set(key, read);
      try { await persist(); }
      catch { fenced = true; for (const entry of selected) { entry.receipt = { ...entry.receipt, status: "unknown", mailbox: { ...entry.receipt.mailbox!, phase: "uncertain", waitReason: "processing_unconfirmed" }, error: "Inbox retrieval persistence is uncertain; no automatic retry" }; emit(entry.receipt); } throw new Error("Inbox retrieval could not be confirmed; preserve this read request_id and reconcile"); }
      assertOwner();
      for (const entry of selected) emit(entry.receipt);
      return { read_request_id: options.requestId, messages: selected.map(entry => inboxMessage(entry, options.requestId, reviewIds.includes(entry.receipt.requestId))), inbox: inboxSummary(caller), instructions: INBOX_GUIDANCE };
    });
  }
  async function acknowledgeMessage(rawCaller: InboxCaller, messageId: string, input: Omit<InboxAcknowledgement, "runId">): Promise<CorrespondenceReceipt> {
    const caller = callerCopy(rawCaller), ack = acknowledgementCopy(input, caller.runId);
    if (!validMessageId(messageId)) throw new Error("Invalid inbox message identity");
    await ensure();
    return serial(async () => {
      assertOwner(); checkpoint.assertAllowed();
      if (fenced) throw new Error("Inbox acknowledgement is fenced after an ambiguous storage failure");
      const entry = entries.get(messageId);
      if (!entry?.receipt.mailbox || !sameParticipant(caller, targetParticipant(entry.receipt.target)) || !entry.claim ||
        entry.claim.runId !== caller.runId || entry.claim.readRequestId !== ack.readRequestId) throw new Error("Inbox acknowledgement does not match its authenticated retrieval");
      if (entry.acknowledgement) {
        if (JSON.stringify(entry.acknowledgement) !== JSON.stringify(ack)) throw new Error("Inbox acknowledgement already has a different outcome");
        return visible(entry.receipt);
      }
      if (entry.receipt.mailbox.phase === "handled" || entry.receipt.status === "failed") throw new Error("Inbox message is already settled");
      if (entry.receipt.mailbox.kind === "correction" && ack.outcome === "handled" && !ack.impactReview) throw new Error("A correction requires impact_review of completed and in-flight actions before acknowledgement");
      entry.acknowledgement = ack;
      const runningOwner = ownsNativeRun(entry) && !terminal.has(entry.receipt.status);
      await change(entry, { ...(runningOwner ? {} : { status: ack.outcome === "handled" ? "completed" as const : "unknown" as const,
        text: ack.response === undefined ? undefined : clip(ack.response, MAX_TEXT), truncated: (ack.response?.length ?? 0) > MAX_TEXT,
        error: ack.outcome === "handled" ? undefined : "The recipient deferred this message; it will not be automatically replayed" }),
        mailbox: { ...entry.receipt.mailbox, phase: ack.outcome, handledAt: ack.outcome === "handled" ? now() : undefined,
          waitReason: ack.outcome === "handled" ? undefined : "processing_unconfirmed", impactReview: ack.impactReview } }, false);
      return visible(entry.receipt);
    });
  }

  function kick() {
    if (disposed || fenced) return;
    if (checkpoint.isPaused()) { wakeRequested = true; return; }
    if (kicking) { wakeRequested = true; return; }
    kicking = true;
    // Do not await native spawn on the serial ledger chain: events may arrive
    // and even finish before the invoke resolves.
    void serial(async () => {
      await ensure();
      const blockedTargets = new Set<string>();
      // Per target, a request the user sent ahead goes first; the rest keep
      // their acceptance order.
      const ordered = [...entries.values()].sort((x, y) => Number(y.priority === true) - Number(x.priority === true));
      for (const entry of ordered) {
        if (disposed || fenced || checkpoint.isPaused()) break;
        if (entry.receipt.status !== "queued" && entry.receipt.status !== "received") continue;
        if (entry.receipt.mailbox) {
          if (entry.receipt.mailbox.phase !== "received") continue;
          const reason = waitingReason(entry);
          if (entry.receipt.mailbox.waitReason !== reason) await change(entry, { mailbox: { ...entry.receipt.mailbox, waitReason: reason } });
          if (reason === "stopped" || reason === "parent_pending") continue;
        }
        const { target, runId } = entry.receipt;
        const key = targetKey(target);
        if (blockedTargets.has(key)) continue;
        blockedTargets.add(key);
        const delivery = entry.priority ? { priority: true } : undefined;
        const session = host.inspect(target, delivery);
        if (session && entry.costReviewedModel !== undefined && entry.costReviewedModel !== (host.model?.(target) ?? null)) {
          await change(entry, { status: "awaiting_cost_approval" });
          continue;
        }
        if (!session) continue;
        if (session.status !== "idle") {
          if (entry.receipt.status === "received") await change(entry, { status: "queued" });
          continue;
        }
        if (reservations.has(key)) continue;
        if (await shouldHoldForCost(entry)) {
          if (disposed || fenced || checkpoint.isPaused()) { wakeRequested = true; break; }
          await change(entry, { status: "awaiting_cost_approval" });
          continue;
        }
        if (disposed || fenced || checkpoint.isPaused()) { wakeRequested = true; break; }
        const readySession = host.inspect(target, delivery);
        if (!readySession) continue;
        if (readySession.status !== "idle") {
          if (entry.receipt.status === "received") await change(entry, { status: "queued" });
          continue;
        }
        if (reservations.has(key)) continue;
        const readRequestId = `turn-${runId}`;
        const bundled: Entry[] = entry.receipt.mailbox ? [entry] : [];
        // Updates still waiting when their original question starts join that
        // prompt, on the same ledger chain as inbox retrieval.
        if (entry.envelope) {
          for (const update of entries.values()) {
            const sameGroup = entry.envelope.relation
              ? update.envelope?.relation?.type === entry.envelope.relation.type && update.envelope.relation.scopedId === entry.envelope.relation.scopedId
              : update.envelope?.relation?.type === "update" && update.envelope.relation.scopedId === entry.receipt.requestId;
            if (update === entry || bundled.length >= 8 || !sameGroup || (!update.priority && stopReason(update)) ||
              update.receipt.mailbox?.phase !== "received" || !["queued", "received"].includes(update.receipt.status) ||
              !sameParticipant(targetParticipant(update.receipt.target), targetParticipant(target))) continue;
            if (await shouldHoldForCost(update)) { await change(update, { status: "awaiting_cost_approval", mailbox: { ...update.receipt.mailbox, waitReason: "cost_approval" } }); continue; }
            const proposed = [...bundled, update].map(item => inboxMessage(item, readRequestId, false));
            if (turnPrompt(entry, proposed).length > 131_072) continue;
            bundled.push(update);
          }
        }
        if (disposed || fenced || checkpoint.isPaused()) { wakeRequested = checkpoint.isPaused(); break; }
        const beforeClaims = bundled.map(item => ({ item, receipt: copy(item.receipt), claim: item.claim, acknowledgement: item.acknowledgement }));
        const restoreClaims = () => { for (const previous of beforeClaims) {
          previous.item.receipt = previous.receipt; previous.item.claim = previous.claim; previous.item.acknowledgement = previous.acknowledgement;
        } };
        const initialStatus = entry.receipt.status;
        for (const item of bundled) claimMessage(item, runId, readRequestId, "turn");
        const prompt = turnPrompt(entry, bundled.map(item => inboxMessage(item, readRequestId, false)));
        reservations.add(key);
        pendingStarts.set(runId, initialStatus);
        await change(entry, { status: "executing" });
        if (disposed || fenced) { reservations.delete(key); continue; }
        for (const item of bundled) if (item !== entry) emit(item.receipt);
        // A prepare barrier can arrive during the durable pre-spawn write.
        // No native send happened yet, so restore its queued acceptance exactly.
        if (checkpoint.isPaused()) {
          const previous = pendingStarts.get(runId) ?? "queued";
          pendingStarts.delete(runId);
          restoreClaims();
          await change(entry, { status: previous });
          reservations.delete(key);
          wakeRequested = true;
          continue;
        }
        // Revalidate after the durable write; never substitute active.
        const beforeSend = host.inspect(target, delivery);
        if (!beforeSend) {
          await change(entry, { status: "unknown", error: "Exact target became unreachable before native send" });
          reservations.delete(key);
          continue;
        }
        if (entry.costReviewedModel !== undefined && entry.costReviewedModel !== (host.model?.(target) ?? null)) {
          pendingStarts.delete(runId);
          restoreClaims();
          await change(entry, { status: "awaiting_cost_approval" });
          reservations.delete(key);
          continue;
        }
        if (beforeSend.status !== "idle") {
          pendingStarts.delete(runId);
          restoreClaims();
          await change(entry, { status: "queued" });
          reservations.delete(key);
          continue;
        }
        if (await shouldHoldForCost(entry)) {
          pendingStarts.delete(runId);
          restoreClaims();
          if (!disposed && !fenced && !checkpoint.isPaused()) {
            await change(entry, { status: "awaiting_cost_approval" });
          } else if (!disposed && !fenced && checkpoint.isPaused()) {
            await change(entry, { status: "queued" });
            wakeRequested = true;
          }
          reservations.delete(key);
          continue;
        }
        if (disposed || fenced || checkpoint.isPaused()) {
          const previous = pendingStarts.get(runId) ?? "queued";
          pendingStarts.delete(runId);
          if (!fenced) restoreClaims();
          if (!disposed && !fenced) await change(entry, { status: previous });
          reservations.delete(key);
          if (checkpoint.isPaused()) wakeRequested = true;
          continue;
        }
        const finalSend = host.inspect(target, delivery);
        if (!finalSend) {
          await change(entry, { status: "unknown", error: "Exact target became unreachable before native send" });
          reservations.delete(key);
          continue;
        }
        if (finalSend.status !== "idle") {
          pendingStarts.delete(runId);
          restoreClaims();
          await change(entry, { status: "queued" });
          reservations.delete(key);
          continue;
        }
        inFlightStarts.add(runId);
        void host.send(target, prompt, runId, delivery).then((result) => serial(async () => {
          if (disposed || terminal.has(entry.receipt.status)) return;
          if (result.runId !== runId || (result.sessionId !== null && result.sessionId !== target.nativeSessionId)) {
            await change(entry, { status: "unknown", error: `Native send ACK identity mismatch: ${clip(JSON.stringify({ actualRunId: result.runId, actualSessionId: result.sessionId }), 768)}` });
            return;
          }
          acknowledgedRuns.add(runId);
          if (result.sessionId === target.nativeSessionId) sessionProvenRuns.add(runId);
          if (!sessionProvenRuns.has(runId)) return;
          pendingStarts.delete(runId);
          const completion = pendingTerminals.get(runId);
          if (completion) await change(entry, completion);
          else await change(entry, { status: "executing" });
        }), (error: unknown) => serial(async () => {
          if (disposed || terminal.has(entry.receipt.status)) return;
          const busyBeforeStart = error instanceof HostChatBusyError && pendingStarts.has(runId);
          if (busyBeforeStart) { pendingStarts.delete(runId); restoreClaims(); }
          await change(entry, busyBeforeStart ? { status: "queued" } :
            { status: "unknown", error: "Native send failed without a conclusive execution acknowledgement; not replayed" });
        })).finally(() => { inFlightStarts.delete(runId); reservations.delete(key); kick(); });
      }
    }).catch(() => { fenced = true; }).finally(() => {
      kicking = false;
      if (wakeRequested) { wakeRequested = false; kick(); }
    });
  }

  async function onEvents(events: EngineEventPayload[]) {
    const changed = new Set<Entry>();
    const update = (entry: Entry, patch: Partial<CorrespondenceReceipt>) => {
      entry.receipt = { ...entry.receipt, ...patch, updatedAt: now() };
      changed.add(entry);
    };
    const output = (entry: Entry, text: string) => {
      const combined = (entry.receipt.text ?? "") + text;
      update(entry, { status: "executing", text: entry.receipt.truncated ? entry.receipt.text : clip(combined, MAX_TEXT),
        truncated: entry.receipt.truncated === true || combined.length > MAX_TEXT });
    };
    const settle = (entry: Entry, result: Partial<HostChatReceipt>) => {
      if (acknowledgedRuns.has(entry.receipt.runId) && sessionProvenRuns.has(entry.receipt.runId)) update(entry, result);
      else pendingTerminals.set(entry.receipt.runId, result);
    };
    for (const event of events) {
      if (event.kind === "done" || event.kind === "error" || event.kind === "turn_complete") {
        for (const message of entries.values()) {
          if (message.claim?.mode !== "tool" || message.claim.runId !== event.runId || message.receipt.mailbox?.phase !== "retrieved" ||
            event.engine !== message.receipt.target.engine || event.sessionId !== message.receipt.target.nativeSessionId) continue;
          update(message, { status: "unknown", error: "The receiving turn ended without an explicit processing receipt; do not automatically replay the message",
            mailbox: { ...message.receipt.mailbox, phase: "uncertain", waitReason: "processing_unconfirmed" } });
        }
      }
      const entry = [...entries.values()].find((e) => e.receipt.runId === event.runId);
      if (!entry || !ownsNativeRun(entry) || terminal.has(entry.receipt.status) ||
        (entry.receipt.status !== "executing" && entry.receipt.status !== "awaiting_permission") ||
        event.engine !== entry.receipt.target.engine ||
        !Number.isInteger(event.seq) || event.seq <= entry.lastSeq) continue;
      if (event.kind === "session" && (event.data !== entry.receipt.target.nativeSessionId || event.sessionId !== entry.receipt.target.nativeSessionId)) {
        update(entry, { status: "unknown", error: "Native session announcement changed identity; target was not rebound" });
        continue;
      }
      if (event.sessionId !== entry.receipt.target.nativeSessionId) continue;
      entry.lastSeq = event.seq;
      sessionProvenRuns.add(event.runId);
      if (pendingStarts.delete(event.runId)) update(entry, { status: "executing" });
      const pendingTerminal = pendingTerminals.get(event.runId);
      if (pendingTerminal) { settle(entry, pendingTerminal); continue; }
      const data = event.data;
      // The native chat protocol also carries plan-review events (the store's
      // wider ChatEngineEvent type); only their approval status is exposed.
      switch (event.kind as string) {
        case "delta":
          if (typeof data === "string") output(entry, data);
          break;
        case "message": {
          const message = data as { role?: string; text?: string } | null;
          if (message?.role === "assistant" && typeof message.text === "string") output(entry, message.text);
          break;
        }
        case "question": case "permission_denied":
          update(entry, { status: "awaiting_permission" }); break;
        case "plan_review": {
          const status = (data as { status?: string } | null)?.status;
          if (status === "awaiting_review" || status === "deferred" || status === "submitting") update(entry, { status: "awaiting_permission" });
          else if (status === "approved") update(entry, { status: "executing" });
          break;
        }
        case "question_settled":
          update(entry, { status: "executing" }); break;
        case "error":
          settle(entry, { status: "failed", error: typeof data === "string" ? clip(data, 1024) : "Native engine failed" }); break;
        case "turn_complete":
          // Stop that only interrupts the reply (the run lives on for its
          // background tasks) sets no store flag and never reaches a done for
          // this request, but to the requester it is the same stopped turn as a
          // kill. The event itself carries the proof; the target stays busy
          // until the run's final done like any other live run.
          if ((data as { interrupted?: unknown } | null)?.interrupted === true) settle(entry, interruptedResult);
          break;
        case "done":
          settle(entry, host.wasInterrupted(entry.receipt.target) ? interruptedResult : { status: "completed" });
          break;
      }
    }
    // One durable write per native batch, not one IPC write per text chunk.
    if (changed.size) {
      for (const entry of changed) for (const related of associatedForRun(entry)) changed.add(related);
      try { await persist(); }
      catch {
        fenced = true;
        for (const entry of changed) entry.receipt = { ...entry.receipt, status: "unknown", updatedAt: now(), error: "Host chat ledger update failed; execution will not be replayed",
          ...(entry.receipt.mailbox ? { mailbox: { ...entry.receipt.mailbox, phase: "uncertain", waitReason: "processing_unconfirmed" } } : {}) };
      }
      for (const entry of changed) { clearTerminal(entry); emit(entry.receipt); }
    }
    kick();
  }

  function captureCheckpoint(): BridgeCheckpoint {
    return cloneCheckpointValue({ version: 1, pluginId, identity: identityCopy(host?.identity ?? restoredIdentity),
      ledger: { version: 1, entries: [...entries.values()], inboxReads: [...inboxReads.values()] }, pendingStarts: [...pendingStarts],
      acknowledgedRuns: [...acknowledgedRuns], sessionProvenRuns: [...sessionProvenRuns],
      pendingTerminals: [...pendingTerminals], endedInboxRuns: [...endedInboxRuns], fenced } satisfies BridgeCheckpoint);
  }

  function restoreCheckpoint(value: unknown) {
    if (inFlightStarts.size || disposed) throw new Error("Cannot replace a live host chat bridge");
    const snapshot = cloneCheckpointValue(value) as BridgeCheckpoint;
    if (!snapshot || snapshot.version !== 1 || snapshot.pluginId !== pluginId || typeof snapshot.fenced !== "boolean" ||
      !Array.isArray(snapshot.pendingStarts) || !Array.isArray(snapshot.acknowledgedRuns) ||
      !Array.isArray(snapshot.sessionProvenRuns) || !Array.isArray(snapshot.pendingTerminals)) throw new Error("Invalid host chat bridge checkpoint");
    const identity = identityCopy(snapshot.identity);
    if (host && (host.identity.clientInstanceId !== identity.clientInstanceId || host.identity.windowId !== identity.windowId)) {
      throw new Error("Host chat checkpoint belongs to another desktop document");
    }
    const nextEntries = ledgerEntries(snapshot.ledger, identity);
    const nextInboxReads = ledgerInboxReads(snapshot.ledger, new Map(nextEntries.map(entry => [entry.receipt.requestId, entry])));
    const nextEnded = snapshot.endedInboxRuns ?? [];
    if (!Array.isArray(nextEnded) || nextEnded.length > 8192 || nextEnded.some(key => typeof key !== "string" || key.length > 16384)) throw new Error("Invalid inbox run checkpoint");
    const activeRuns = new Set(nextEntries.filter((entry) => ownsNativeRun(entry) && ["executing", "awaiting_permission"].includes(entry.receipt.status)).map((entry) => entry.receipt.runId));
    const runSet = (values: string[]) => {
      if (values.length > MAX_REQUESTS || values.some((run) => typeof run !== "string" || !activeRuns.has(run)) || new Set(values).size !== values.length) {
        throw new Error("Invalid host chat checkpoint run proof");
      }
      return new Set(values);
    };
    const nextAcknowledged = runSet(snapshot.acknowledgedRuns);
    const nextProven = runSet(snapshot.sessionProvenRuns);
    const nextStarts = new Map<string, HostChatReceipt["status"]>();
    for (const pair of snapshot.pendingStarts) {
      if (!Array.isArray(pair) || pair.length !== 2 || !activeRuns.has(pair[0]) || nextStarts.has(pair[0]) || !["queued", "received"].includes(pair[1])) {
        throw new Error("Invalid host chat checkpoint pending start");
      }
      nextStarts.set(pair[0], pair[1]);
    }
    const nextTerminals = new Map<string, Partial<HostChatReceipt>>();
    for (const pair of snapshot.pendingTerminals) {
      const patch = Array.isArray(pair) ? pair[1] : undefined;
      if (!Array.isArray(pair) || pair.length !== 2 || !activeRuns.has(pair[0]) || nextTerminals.has(pair[0]) || !patch ||
        !terminal.has(patch.status ?? "") || Object.keys(patch).some((key) => key !== "status" && key !== "error") ||
        (patch.error !== undefined && (typeof patch.error !== "string" || patch.error.length > 1024))) {
        throw new Error("Invalid host chat checkpoint pending terminal");
      }
      nextTerminals.set(pair[0], patch);
    }
    if (snapshot.pendingStarts.length > MAX_REQUESTS || snapshot.pendingTerminals.length > MAX_REQUESTS ||
      nextEntries.some((entry) => ownsNativeRun(entry) && ["executing", "awaiting_permission"].includes(entry.receipt.status) && !nextAcknowledged.has(entry.receipt.runId))) {
      throw new Error("Host chat checkpoint contains an unpublished native start");
    }
    // Install synchronously. ensure() must not later replace this cut with a KV
    // ledger load that treats all active receipts as crash uncertainty.
    entries.clear(); nextEntries.forEach((entry) => entries.set(entry.receipt.requestId, entry));
    inboxReads.clear(); for (const read of nextInboxReads) inboxReads.set(JSON.stringify([read.caller, read.requestId]), read);
    endedInboxRuns.clear(); for (const key of nextEnded) endedInboxRuns.add(key);
    pendingStarts.clear(); nextStarts.forEach((status, run) => pendingStarts.set(run, status));
    acknowledgedRuns.clear(); nextAcknowledged.forEach((run) => acknowledgedRuns.add(run));
    sessionProvenRuns.clear(); nextProven.forEach((run) => sessionProvenRuns.add(run));
    pendingTerminals.clear(); nextTerminals.forEach((patch, run) => pendingTerminals.set(run, patch));
    fenced = snapshot.fenced;
    restored = true;
    restoredIdentity = identity;
    const previous = restorationCache(checkpoint).get(participantId);
    predecessorDrain = previous?.drain ?? Promise.resolve();
    restorationCache(checkpoint).set(participantId, { snapshot: captureCheckpoint(), owner: checkpointOwner, drain: predecessorDrain });
  }

  const participant: RuntimeCheckpointParticipant = {
    id: participantId, capture: captureCheckpoint, restore: restoreCheckpoint,
    readiness: () => {
      const reasons: string[] = [];
      if (initializationFailure) reasons.push("ledger-initialization-failed");
      if (fenced) reasons.push("ledger-ambiguous");
      if (inFlightStarts.size) reasons.push("native-start-unpublished");
      return reasons;
    },
    async ready() { await ready(); await deps.checkpointReady?.(); await ready(); },
    resumed() {
      const cache = restorationCache(checkpoint);
      if (cache.get(participantId)?.owner === checkpointOwner) cache.delete(participantId);
      wakeRequested = false;
      kick();
      deps.resumed?.();
    },
  };
  unregisterCheckpoint = checkpoint.register(participant);
  // React StrictMode can dispose the first restored owner before the bootstrap
  // commits. The coordinator consumed its pending value at first registration;
  // retain it locally, only while paused, for the replacement effect owner.
  const inherited = restorationCache(checkpoint).get(participantId);
  if (!restored && checkpoint.isPaused() && inherited) restoreCheckpoint(inherited.snapshot);

  /** Host-only queue controls for a request still waiting on its target. A
   *  started, finished or unknown request is returned unchanged. */
  const pending = (requestId: string, apply: (entry: Entry) => Promise<void>, includeCostApproval = false) => serial(async () => {
    if (disposed) throw new Error("Host chat bridge has been disposed");
    const entry = entries.get(requestId);
    if (!entry) return null;
    if (entry.receipt.status === "queued" || entry.receipt.status === "received" ||
      (includeCostApproval && entry.receipt.status === "awaiting_cost_approval")) await apply(entry);
    return visible(entry.receipt);
  });

  async function submit(
    request: HostChatSubmission,
    requiresCostApproval = false,
    costGuard = false,
    reviewedModel?: string | null,
    checkCost?: () => Promise<boolean> | boolean,
    rawEnvelope?: CorrespondenceEnvelope,
  ): Promise<CorrespondenceReceipt> {
    if (!validRequestId(request?.requestId) || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 131_072) throw new Error("Invalid host chat requestId or prompt");
    const target = targetCopy(request.target);
    const requestId = request.requestId;
    const prompt = request.prompt;
    const fingerprint = JSON.stringify([target, prompt]);
    const envelope = rawEnvelope ? envelopeCopy(rawEnvelope) : undefined;
    if (envelope && sameParticipant(envelope.sender, targetParticipant(target))) throw new Error("Cannot send correspondence to the sender's own session");
    if (envelope?.relation && (!validMessageId(requestId) || new TextEncoder().encode(JSON.stringify(prompt)).length > MAX_RELATED_MESSAGE_BYTES)) throw new Error("Associated message is too large; split it into smaller updates with the same original request reference");
    await ensure();
    return serial(async () => {
      if (disposed) throw new Error("Host chat bridge has been disposed");
      if (target.clientInstanceId !== host.identity.clientInstanceId || target.windowId !== host.identity.windowId) throw new Error("Exact host chat target belongs to a different desktop document");
      const previous = entries.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Host chat requestId already belongs to a different target or prompt");
        if (envelope && previous.envelope && (!sameParticipant(envelope.sender, previous.envelope.sender) || previous.envelope.requestId !== envelope.requestId ||
          previous.envelope.kind !== envelope.kind || previous.envelope.relation?.type !== envelope.relation?.type || previous.envelope.relation?.requestId !== envelope.relation?.requestId)) throw new Error("Correspondence requestId already belongs to a different relation or sender");
        if (envelope?.relation && !previous.envelope) throw new Error("An independent request cannot become an associated message");
        return visible(previous.receipt);
      }
      checkpoint.assertAllowed();
      if (fenced) throw new Error("Host chat ledger is fenced after an ambiguous storage failure");
      const initialSession = host.inspect(target);
      if (!initialSession) throw new Error("Exact host chat target is unavailable (open, loaded native timeline required)");
      if (entries.size >= MAX_REQUESTS) throw new Error("Host chat request ledger capacity reached");
      if (envelope?.relation) {
        const relation = envelope.relation;
        const matches = [...entries.values()].filter(candidate => !candidate.envelope?.relation &&
          (candidate.receipt.requestId === relation.scopedId || (candidate.envelope?.requestId === relation.requestId &&
            sameParticipant(candidate.envelope.sender, relation.type === "update" ? envelope.sender : targetParticipant(target)))) &&
          sameParticipant(targetParticipant(candidate.receipt.target), relation.type === "update" ? targetParticipant(target) : envelope.sender));
        if (matches.length !== 1) throw new Error("Related original request is unavailable, ambiguous or belongs to different participants");
        const parent = matches[0];
        if (parent.envelope && (parent.envelope.requestId !== relation.requestId ||
          !sameParticipant(parent.envelope.sender, relation.type === "update" ? envelope.sender : targetParticipant(target)))) throw new Error("Related request sender does not match");
        relation.scopedId = parent.receipt.requestId;
      }
      if (costGuard && checkCost) costGuards.set(requestId, checkCost);
      const initialModel = host.model?.(target) ?? null;
      const costReviewedModel = costGuard ? reviewedModel === undefined ? initialModel : reviewedModel : undefined;
      let needsApproval = requiresCostApproval || (costGuard && costReviewedModel !== initialModel);
      if (!needsApproval && costGuard && initialSession.status === "idle") {
        needsApproval = await evaluateCostGuard(requestId, target);
        if (disposed) throw new Error("Host chat bridge has been disposed");
        checkpoint.assertAllowed();
        if (fenced) throw new Error("Host chat ledger is fenced after an ambiguous storage failure");
      }
      const session = host.inspect(target);
      if (!session) {
        costGuards.delete(requestId);
        throw new Error("Exact host chat target is unavailable (open, loaded native timeline required)");
      }
      const currentModel = host.model?.(target) ?? null;
      if (costGuard && costReviewedModel !== currentModel) needsApproval = true;
      const at = now();
      const entry: Entry = { prompt, fingerprint, lastSeq: -1, ...(costGuard ? { costGuard: true, costReviewedModel } : {}), receipt: { requestId, target,
        runId: deps.runId?.() ?? `run-${newId()}`, status: needsApproval ? "awaiting_cost_approval" : session.status === "idle" ? "received" : "queued", acceptedAt: at, updatedAt: at } };
      if (envelope) entry.envelope = envelope;
      if (envelope?.relation) entry.receipt.mailbox = { phase: "received", relation: envelope.relation.type, parentRequestId: envelope.relation.requestId,
        kind: envelope.kind ?? "information", waitReason: needsApproval ? "cost_approval" : session.status === "awaiting_permission" ? "permission" : session.status === "busy" ? "target_busy" : undefined };
      if (turnPrompt(entry, entry.receipt.mailbox ? [inboxMessage(entry, `turn-${entry.receipt.runId}`, false)] : []).length > 131_072) {
        costGuards.delete(requestId); throw new Error("Attributed correspondence exceeds the delivery budget; split the message before sending");
      }
      entries.set(requestId, entry);
      try { await persist(); }
      catch { entries.delete(requestId); costGuards.delete(requestId); fenced = true; throw new Error("Host chat acceptance could not be persisted; no native send was started"); }
      emit(entry.receipt);
      kick();
      return visible(entry.receipt);
    });
  }

  return {
    ready,
    submitCorrespondence: (request, envelope, cost = {}) => submit(request, cost.requiresCostApproval, cost.costGuard, cost.reviewedModel, cost.checkCost, envelope),
    async findCorrespondence(rawCaller, requestId) {
      const caller = callerCopy(rawCaller); await ensure();
      return serial(async () => {
        const found = [...entries.values()].filter(entry => entry.envelope?.requestId === requestId && sameParticipant(entry.envelope.sender, caller));
        if (found.length > 1) throw new Error("Correspondence identity is ambiguous; reconcile existing receipts before retrying");
        return found.length ? visible(found[0].receipt) : null;
      });
    },
    async inboxStatus(rawCaller) { const caller = callerCopy(rawCaller); await ensure(); return serial(async () => { assertOwner(); return inboxSummary(caller); }); },
    readMessages,
    acknowledgeMessage,
    submitForCostApproval: (request) => submit(request, true),
    async submitWithCostGuard(request, reviewedModel, requiresCostApproval) {
      if (reviewedModel !== undefined && reviewedModel !== null && typeof reviewedModel !== "string") {
        throw new Error("Invalid host chat cost guard model");
      }
      if (requiresCostApproval !== undefined && typeof requiresCostApproval !== "function") {
        throw new Error("Invalid host chat cost guard");
      }
      return submit(request, false, true, reviewedModel, requiresCostApproval);
    },
    async approveCost(requestId, reviewedModel) {
      await ensure();
      const receipt = await serial(async () => {
        assertOwner();
        const entry = entries.get(requestId);
        if (!entry) return null;
        if (entry.receipt.status === "awaiting_cost_approval") {
          checkpoint.assertAllowed();
          if (fenced) throw new Error("Host chat ledger is fenced after an ambiguous storage failure");
          const session = host.inspect(entry.receipt.target);
          if (!session) throw new Error("Exact host chat target is unavailable (open, loaded native timeline required)");
          const currentModel = host.model?.(entry.receipt.target) ?? null;
          if (reviewedModel !== undefined && reviewedModel !== currentModel) throw new Error("Host chat target model changed before cost approval");
          entry.costReviewedModel = currentModel;
          delete entry.costGuard;
          costGuards.delete(requestId);
          await change(entry, { status: session.status === "idle" ? "received" : "queued" });
        }
        return visible(entry.receipt);
      });
      kick();
      return receipt;
    },
    /** Send ahead of the target's own queued rows at its next idle moment. */
    async prioritize(requestId: string): Promise<HostChatReceipt | null> {
      await ensure();
      const receipt = await pending(requestId, async (entry) => {
        if (entry.priority) return;
        if (fenced) throw new Error("Host chat ledger is fenced after an ambiguous storage failure");
        entry.priority = true;
        const parent = entry.envelope?.relation?.type === "update" ? entries.get(entry.envelope.relation.scopedId) : undefined;
        if (parent && ["queued", "received"].includes(parent.receipt.status)) parent.priority = true;
        await change(entry, {});
      });
      kick();
      return receipt;
    },
    /** Withdraw a request before any native send; the sender sees a failure. */
    async cancel(requestId: string): Promise<HostChatReceipt | null> {
      await ensure();
      return pending(requestId, (entry) => change(entry, { status: "failed", error: "Cancelled by the user before delivery" }), true);
    },
    async identity() {
      await ensure();
      if (disposed) throw new Error("Host chat bridge has been disposed");
      return { clientInstanceId: host.identity.clientInstanceId, windowId: host.identity.windowId };
    },
    async current() { await ensure(); return disposed ? null : host.current(); },
    async inspect(target) { const exact = targetCopy(target); await ensure(); return disposed || exact.clientInstanceId !== host.identity.clientInstanceId || exact.windowId !== host.identity.windowId ? null : host.inspect(exact); },
    submit: (request) => submit(request),
    async receipt(requestId) { await ensure(); return serial(async () => entries.has(requestId) ? visible(entries.get(requestId)!.receipt) : null); },
    onEvent(callback) {
      if (disposed) throw new Error("Host chat bridge has been disposed");
      listeners.add(callback);
      void ensure().catch(() => { console.error("[plugins] host chat receipt subscription unavailable"); });
      return () => { listeners.delete(callback); };
    },
    dispose() {
      if (disposed) return;
      const cache = restorationCache(checkpoint);
      if (restored && checkpoint.isPaused() && cache.get(participantId)?.owner === checkpointOwner) {
        // Wait for the old owner's already-issued KV requests before the next
        // owner persists this cut, so late old writes cannot win afterwards.
        const drain = Promise.allSettled([predecessorDrain, init ?? Promise.resolve(), chain]).then(() => undefined);
        cache.set(participantId, { snapshot: captureCheckpoint(), owner: checkpointOwner, drain });
      }
      disposed = true;
      unregisterCheckpoint();
      listeners.clear(); acknowledgedRuns.clear(); sessionProvenRuns.clear(); pendingTerminals.clear(); pendingStarts.clear(); costGuards.clear();
      for (const off of disposers.splice(0)) off();
    },
  };
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
