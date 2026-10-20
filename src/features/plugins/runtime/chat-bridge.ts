import type { Disposer, HostChatIdentity, HostChatTarget, HostChatSession, HostChatSubmission, HostChatReceipt, PluginContext } from "@ccgui/plugin-sdk";
import { listenEngineEvents, type EngineEventPayload } from "@/lib/events";
import { newId } from "@/lib/id";
import { isWeb } from "@/lib/transport";
import { HostChatBusyError } from "@/features/chat/store/types";
import { crossSessionCostReview, requiresCrossSessionCostApproval } from "@/features/chat/cross-session-cost";
import { resolveSessionModel } from "@/features/chat/store/stream";
import { cloneCheckpointValue, runtimeCheckpoint, type RuntimeCheckpoint, type RuntimeCheckpointParticipant } from "@/lib/runtime-checkpoint";
import type { PluginStorageBackend } from "./context";

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
function copy(receipt: HostChatReceipt): HostChatReceipt { return { ...receipt, target: { ...receipt.target } }; }
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
      return requiresCrossSessionCostApproval(review) || !review.cache;
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

interface Entry { receipt: HostChatReceipt; prompt: string; fingerprint: string; lastSeq: number; priority?: true; costGuard?: true; costReviewedModel?: string | null }
interface Ledger { version: 1; entries: Entry[] }
interface BridgeCheckpoint {
  version: 1;
  pluginId: string;
  identity: HostChatIdentity;
  ledger: Ledger;
  pendingStarts: Array<[string, HostChatReceipt["status"]]>;
  acknowledgedRuns: string[];
  sessionProvenRuns: string[];
  pendingTerminals: Array<[string, Partial<HostChatReceipt>]>;
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
    return entry;
  });
}
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
  } {
  const now = deps.now ?? Date.now;
  const checkpoint = deps.checkpoint ?? runtimeCheckpoint;
  const participantId = hostChatCheckpointId(pluginId);
  const checkpointOwner = Symbol(participantId);
  let predecessorDrain: Promise<void> = Promise.resolve();
  const entries = new Map<string, Entry>();
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
  const visible = (receipt: HostChatReceipt) => copy({ ...receipt, status: pendingStarts.get(receipt.runId) ?? receipt.status });
  const emit = (receipt: HostChatReceipt) => {
    if (disposed) return;
    for (const cb of [...listeners]) {
      try { cb(visible(receipt)); } catch { console.error("[plugins] host chat receipt listener failed"); }
    }
  };
  const persist = () => {
    assertOwner();
    return storage.set(pluginId, ledgerKey, structuredClone({ version: 1, entries: [...entries.values()] } satisfies Ledger));
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
  const shouldHoldForCost = async (entry: Entry): Promise<boolean> => {
    const { target, requestId } = entry.receipt;
    if (entry.costReviewedModel !== undefined && entry.costReviewedModel !== (host.model?.(target) ?? null)) {
      return true;
    }
    if (!entry.costGuard) return false;
    return evaluateCostGuard(requestId, target);
  };
  const change = async (entry: Entry, patch: Partial<HostChatReceipt>) => {
    if (disposed) return;
    entry.receipt = { ...entry.receipt, ...patch, updatedAt: now() };
    try { await persist(); }
    catch {
      fenced = true;
      entry.receipt = { ...entry.receipt, status: "unknown", error: "Host chat ledger update failed; execution will not be replayed", updatedAt: now() };
    }
    clearTerminal(entry);
    emit(entry.receipt);
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
        }
        entries.set(entry.receipt.requestId, entry);
      }
    }
    if (restored) {
      for (const entry of entries.values()) {
        const completion = pendingTerminals.get(entry.receipt.runId);
        if (completion && acknowledgedRuns.has(entry.receipt.runId) && sessionProvenRuns.has(entry.receipt.runId)) {
          entry.receipt = { ...entry.receipt, ...completion, updatedAt: now() };
          clearTerminal(entry);
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
        reservations.add(key);
        pendingStarts.set(runId, entry.receipt.status);
        await change(entry, { status: "executing" });
        if (disposed || fenced) { reservations.delete(key); continue; }
        // A prepare barrier can arrive during the durable pre-spawn write.
        // No native send happened yet, so restore its queued acceptance exactly.
        if (checkpoint.isPaused()) {
          const previous = pendingStarts.get(runId) ?? "queued";
          pendingStarts.delete(runId);
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
          await change(entry, { status: "awaiting_cost_approval" });
          reservations.delete(key);
          continue;
        }
        if (beforeSend.status !== "idle") {
          pendingStarts.delete(runId);
          await change(entry, { status: "queued" });
          reservations.delete(key);
          continue;
        }
        if (await shouldHoldForCost(entry)) {
          pendingStarts.delete(runId);
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
          await change(entry, { status: "queued" });
          reservations.delete(key);
          continue;
        }
        inFlightStarts.add(runId);
        void host.send(target, entry.prompt, runId, delivery).then((result) => serial(async () => {
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
          if (busyBeforeStart) pendingStarts.delete(runId);
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
    const update = (entry: Entry, patch: Partial<HostChatReceipt>) => {
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
      const entry = [...entries.values()].find((e) => e.receipt.runId === event.runId);
      if (!entry || terminal.has(entry.receipt.status) ||
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
      try { await persist(); }
      catch {
        fenced = true;
        for (const entry of changed) entry.receipt = { ...entry.receipt, status: "unknown", updatedAt: now(), error: "Host chat ledger update failed; execution will not be replayed" };
      }
      for (const entry of changed) { clearTerminal(entry); emit(entry.receipt); }
    }
    kick();
  }

  function captureCheckpoint(): BridgeCheckpoint {
    return cloneCheckpointValue({ version: 1, pluginId, identity: identityCopy(host?.identity ?? restoredIdentity),
      ledger: { version: 1, entries: [...entries.values()] }, pendingStarts: [...pendingStarts],
      acknowledgedRuns: [...acknowledgedRuns], sessionProvenRuns: [...sessionProvenRuns],
      pendingTerminals: [...pendingTerminals], fenced } satisfies BridgeCheckpoint);
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
    const activeRuns = new Set(nextEntries.filter((entry) => ["executing", "awaiting_permission"].includes(entry.receipt.status)).map((entry) => entry.receipt.runId));
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
      nextEntries.some((entry) => ["executing", "awaiting_permission"].includes(entry.receipt.status) && !nextAcknowledged.has(entry.receipt.runId))) {
      throw new Error("Host chat checkpoint contains an unpublished native start");
    }
    // Install synchronously. ensure() must not later replace this cut with a KV
    // ledger load that treats all active receipts as crash uncertainty.
    entries.clear(); nextEntries.forEach((entry) => entries.set(entry.receipt.requestId, entry));
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
  ): Promise<HostChatReceipt> {
    if (!validRequestId(request?.requestId) || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 131_072) throw new Error("Invalid host chat requestId or prompt");
    const target = targetCopy(request.target);
    const requestId = request.requestId;
    const prompt = request.prompt;
    const fingerprint = JSON.stringify([target, prompt]);
    await ensure();
    return serial(async () => {
      if (disposed) throw new Error("Host chat bridge has been disposed");
      if (target.clientInstanceId !== host.identity.clientInstanceId || target.windowId !== host.identity.windowId) throw new Error("Exact host chat target belongs to a different desktop document");
      const previous = entries.get(requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Host chat requestId already belongs to a different target or prompt");
        return visible(previous.receipt);
      }
      checkpoint.assertAllowed();
      if (fenced) throw new Error("Host chat ledger is fenced after an ambiguous storage failure");
      const initialSession = host.inspect(target);
      if (!initialSession) throw new Error("Exact host chat target is unavailable (open, loaded native timeline required)");
      if (entries.size >= MAX_REQUESTS) throw new Error("Host chat request ledger capacity reached");
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
