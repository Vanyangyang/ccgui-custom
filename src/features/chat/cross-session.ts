import { create } from "zustand";
import type { HostChatReceipt, HostChatTarget, PluginContext } from "@ccgui/plugin-sdk";
import { ipc, type SessionMeta, type Workspace } from "@/lib/ipc";
import { invoke, isWeb, listen } from "@/lib/transport";
import { useChatStore, sessionKey } from "./store";
import { getSessionCacheHeat, promptCacheForEngine } from "./prompt-cache";
import { HostChatBusyError, type ChatStore } from "./store/types";
import { createHostChatBridge, desktopChatFacade, type HostChatFacade } from "@/features/plugins/runtime/chat-bridge";
import type { PluginStorageBackend } from "@/features/plugins/runtime/context";
import { cloneCheckpointValue, runtimeCheckpoint } from "@/lib/runtime-checkpoint";
import { crossSessionCostReview, requiresCrossSessionCostApproval, type CrossSessionCostReview } from "./cross-session-cost";
import { leaderWorkspacePathKey } from "@/features/leader/workspace-path";
import { workspaceCatalogPathKey } from "@/lib/workspace-path";
import { handlePluginManagementRequest, isPluginManagementMethod } from "@/features/plugins/runtime/management";
import { handleWorkspaceOrganizationRequest, isWorkspaceOrganizationMethod } from "@/features/projects/management";
import { sameParticipant, targetParticipant, type CorrespondenceEnvelope, type CorrespondenceReceipt, type InboxCaller,
  type InboxMessageKind, type InboxReceiptState, type InboxSummary, type ManagedParentTarget } from "@/features/plugins/runtime/chat-inbox";
import { createManagedParentDelivery } from "./managed-parent-delivery";

export interface CrossSessionRequest {
  requestId: string;
  sender: { runId: string; engine: string; sessionId: string | null; workspacePath: string };
  method: string;
  arguments: Record<string, unknown>;
  /** Native-only proof; send_message arguments cannot select this route. */
  managedParent?: ManagedParentTarget;
}

export type CrossSessionCommunicationStatus = "preparing" | HostChatReceipt["status"];

export interface CrossSessionParticipant {
  engine: string;
  sessionId: string;
  workspacePath: string;
  title?: string;
}

export interface CrossSessionCommunicationRecord {
  leaderCostApproval?: { branchId: string; requestId: string; model?: string | null };
  scopedId: string;
  requestId: string;
  runId?: string;
  kind?: "consultation" | "subtask";
  sender: CrossSessionParticipant;
  target: CrossSessionParticipant;
  message: string;
  status: CrossSessionCommunicationStatus;
  replyText?: string;
  truncated?: boolean;
  error?: string;
  acceptedAt: number;
  updatedAt: number;
  /** Native branch timestamp; preview arrival times must not order snapshots. */
  leaderUpdatedAt?: number;
  /** Identifies the durable assignment timestamp domain after legacy checkpoint migration. */
  leaderDelegationId?: string;
  reviewedBy?: string[];
  costReview?: CrossSessionCostReview;
  mailbox?: InboxReceiptState;
}

export function isCrossSessionActiveStatus(status: CrossSessionCommunicationStatus): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "received" ||
    status === "executing" ||
    status === "awaiting_cost_approval" ||
    status === "awaiting_permission"
  );
}
export function isCrossSessionPendingRecord(record: CrossSessionCommunicationRecord): boolean {
  return isCrossSessionActiveStatus(record.status) || (!!record.mailbox && record.mailbox.phase !== "handled" && record.status !== "failed");
}

export function crossSessionParticipantKey(participant: CrossSessionParticipant): string {
  return JSON.stringify([participant.engine, participant.sessionId, leaderWorkspacePathKey(participant.workspacePath)]);
}

export function crossSessionRecordMatchesParticipant(
  record: CrossSessionCommunicationRecord,
  participant: CrossSessionParticipant,
): boolean {
  const key = crossSessionParticipantKey(participant);
  return [record.sender, record.target].some((side) => crossSessionParticipantKey(side) === key);
}

export function isCrossSessionRecordUnread(
  record: CrossSessionCommunicationRecord,
  participant?: CrossSessionParticipant,
): boolean {
  if (isCrossSessionActiveStatus(record.status)) return false;
  // Successful child work remains available in history without a completion prompt.
  if (record.kind === "subtask" && record.status === "completed") return false;
  if (participant && !crossSessionRecordMatchesParticipant(record, participant)) return false;
  return (participant ? [participant] : [record.sender, record.target])
    .some((side) => !record.reviewedBy?.includes(crossSessionParticipantKey(side)));
}

function sameReviewContent(
  current: CrossSessionCommunicationRecord,
  observed: CrossSessionCommunicationRecord,
): boolean {
  return (
    current.status === observed.status &&
    current.replyText === observed.replyText &&
    current.error === observed.error &&
    current.message === observed.message &&
    (current.runId === undefined || observed.runId === undefined || current.runId === observed.runId)
  );
}

function preserveReview(
  current: CrossSessionCommunicationRecord,
  updated: CrossSessionCommunicationRecord,
): CrossSessionCommunicationRecord {
  return {
    ...updated,
    reviewedBy: sameReviewContent(current, updated)
      ? current.reviewedBy
      : undefined,
  };
}

const MAX_CROSS_SESSION_RECORDS = 30;
function retainedRecords(records: CrossSessionCommunicationRecord[]) {
  let finished = 0;
  return records.filter((r) => isCrossSessionPendingRecord(r) || ++finished <= MAX_CROSS_SESSION_RECORDS);
}

interface CrossSessionActivityState {
  records: CrossSessionCommunicationRecord[];
  upsertRecord: (record: CrossSessionCommunicationRecord) => void;
  removeRecords: (scopedIds: Iterable<string>) => void;
  applyReceipt: (receipt: CorrespondenceReceipt) => void;
  markFailed: (scopedId: string, error: string) => void;
  markReviewed: (observedRecords: CrossSessionCommunicationRecord[], participant?: CrossSessionParticipant) => void;
  clearFinished: () => void;
  reset: () => void;
}

export const useCrossSessionActivityStore = create<CrossSessionActivityState>((set) => ({
  records: [],
  upsertRecord: (record) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.scopedId === record.scopedId);
      const next =
        idx >= 0
          ? state.records.map((r, i) => (i === idx ? preserveReview(r, { ...r, ...record }) : r))
          : retainedRecords([record, ...state.records]);
      return {
        records: next,
      };
    }),
  removeRecords: (scopedIds) =>
    set((state) => {
      const target = new Set(scopedIds);
      if (!target.size) return state;
      const next = state.records.filter((r) => !target.has(r.scopedId));
      return next.length === state.records.length ? state : { records: next };
    }),
  applyReceipt: (receipt) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.scopedId === receipt.requestId);
      if (idx < 0) return state;
      const current = state.records[idx];
      // A local preparing record has no native run yet, so its wall-clock
      // timestamp must not reject the first receipt. Once bound, a delayed
      // submit/status response cannot overwrite newer events for that request.
      if (current.runId !== undefined) {
        if (receipt.runId !== current.runId || receipt.updatedAt < current.updatedAt) return state;
        if (receipt.updatedAt === current.updatedAt &&
          (current.status === "completed" || current.status === "failed") &&
          isCrossSessionActiveStatus(receipt.status)) return state;
      }
      const updated: CrossSessionCommunicationRecord = {
        ...current,
        status: receipt.status,
        runId: receipt.runId ?? current.runId,
        replyText: receipt.text ?? current.replyText,
        truncated: receipt.truncated ?? current.truncated,
        error: receipt.error ?? current.error,
        acceptedAt: receipt.acceptedAt || current.acceptedAt,
        updatedAt: receipt.updatedAt || Date.now(),
        mailbox: receipt.mailbox ? { ...receipt.mailbox } : current.mailbox,
      };
      const next = [...state.records];
      next[idx] = preserveReview(current, updated);
      return {
        records: next,
      };
    }),
  markFailed: (scopedId, error) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.scopedId === scopedId);
      if (idx < 0) return state;
      const next = [...state.records];
      next[idx] = preserveReview(next[idx], { ...next[idx], status: "failed", error, updatedAt: Date.now() });
      return { records: next };
    }),
  markReviewed: (observedRecords, participant) =>
    set((state) => {
      const observedById = new Map(observedRecords.map((record) => [record.scopedId, record]));
      let changed = false;
      const records = state.records.map((record) => {
        const observed = observedById.get(record.scopedId);
        // An effect from an older render must not consume a newer result that
        // arrived between rendering the details and acknowledging them.
        if (!observed || !sameReviewContent(record, observed) ||
          crossSessionParticipantKey(record.sender) !== crossSessionParticipantKey(observed.sender) ||
          crossSessionParticipantKey(record.target) !== crossSessionParticipantKey(observed.target) ||
          !isCrossSessionRecordUnread(record, participant)) return record;
        const reviewedBy = [...new Set([
          ...(record.reviewedBy ?? []),
          ...(participant ? [participant] : [record.sender, record.target]).map(crossSessionParticipantKey),
        ])];
        changed = true;
        return { ...record, reviewedBy };
      });
      return changed ? { records } : state;
    }),
  clearFinished: () =>
    set((state) => ({
      records: state.records.filter(isCrossSessionPendingRecord),
    })),
  reset: () => set({ records: [] }),
}));

// The approval card must survive the same runtime handoff as its held ledger
// entry. A normal new desktop document retains the bridge's no-replay policy.
export function captureCrossSessionActivity() {
  return { version: 1, records: cloneCheckpointValue(useCrossSessionActivityStore.getState().records) };
}
export function restoreCrossSessionActivity(value: unknown) {
  const snapshot = cloneCheckpointValue(value) as { version?: number; records?: CrossSessionCommunicationRecord[] };
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length > 1024 ||
    snapshot.records.some((r) => !r || typeof r.scopedId !== "string" || typeof r.message !== "string" ||
      !r.sender?.sessionId || !r.target?.sessionId)) throw new Error("Invalid cross-session activity checkpoint");
  useCrossSessionActivityStore.setState({ records: retainedRecords(snapshot.records.map((record) =>
    record.status === "preparing"
      ? { ...record, status: "unknown" as const, error: "History preparation did not finish before runtime handoff; no automatic resend" }
      : record)) });
}
const unregisterActivityCheckpoint = runtimeCheckpoint.register({
  id: "cross-session-activity",
  capture: captureCrossSessionActivity,
  restore: restoreCrossSessionActivity,
});
if (import.meta.hot) import.meta.hot.dispose(unregisterActivityCheckpoint);

type Bridge = Pick<PluginContext["chat"], "identity" | "inspect" | "submit" | "receipt"> &
  Pick<ReturnType<typeof createHostChatBridge>, "submitForCostApproval" | "submitWithCostGuard"> & Partial<Pick<PluginContext["chat"], "onEvent">> &
  Partial<Pick<ReturnType<typeof createHostChatBridge>, "submitCorrespondence" | "findCorrespondence" | "inboxStatus" | "readMessages" | "acknowledgeMessage">>;
interface Dependencies {
  store: { getState(): ChatStore };
  bridge: Bridge;
  catalog(): Promise<{ sessions: SessionMeta[]; archived: SessionMeta[]; workspaces: Workspace[] }>;
  isActive?(): boolean;
}
const storage: PluginStorageBackend = {
  get: (_id, key) => invoke("host_chat_ledger_get", { key }),
  set: (_id, key, value) => invoke("host_chat_ledger_set", { key, value }),
  delete: (_id, key) => invoke("host_chat_ledger_delete", { key }),
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value;
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(value)) throw new Error("Invalid request_id");
  return value;
}
function waitSeconds(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
    throw new Error("wait_seconds must be an integer from 0 to 20");
  }
  return value;
}
function isSettledReceipt(receipt: HostChatReceipt | null): boolean {
  return !receipt || receipt.status === "completed" || receipt.status === "failed" ||
    receipt.status === "unknown" || receipt.status === "awaiting_permission" || receipt.status === "awaiting_cost_approval";
}
async function waitForReceipt(
  bridge: Bridge,
  scoped: string,
  initial: HostChatReceipt | null,
  seconds: number,
  assertActive: () => void,
  inboxCaller?: InboxCaller,
): Promise<HostChatReceipt | null> {
  const onEvent = bridge.onEvent;
  if (seconds <= 0 || isSettledReceipt(initial) || !onEvent) return initial;
  return new Promise<HostChatReceipt | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (next?: HostChatReceipt | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
      if (next !== undefined) {
        resolve(next);
      } else {
        void bridge.receipt(scoped).then(resolve, () => resolve(initial));
      }
    };
    const off = onEvent((receipt) => {
      if (receipt.requestId === scoped && isSettledReceipt(receipt)) {
        finish(receipt);
      } else if (inboxCaller && (receipt as CorrespondenceReceipt).mailbox?.phase === "received" &&
        receipt.status !== "awaiting_cost_approval" && sameParticipant(inboxCaller, targetParticipant(receipt.target))) {
        finish();
      }
    });
    timer = setTimeout(() => finish(), seconds * 1000);
    void bridge.receipt(scoped).then((latest) => {
      if (isSettledReceipt(latest)) finish(latest);
    }, () => finish(initial));
  }).then((receipt) => {
    assertActive();
    return receipt;
  });
}
async function scopedId(sender: CrossSessionRequest["sender"], id: string) {
  requiredString(sender?.sessionId, "sender session identity");
  for (const name of ["runId", "engine", "workspacePath"] as const) requiredString(sender[name], `sender ${name}`);
  // A chat keeps its request identities across later native turns. runId is
  // trusted provenance, but is not the saved sender chat's identity.
  const input = JSON.stringify([sender.engine, sender.sessionId, sender.workspacePath, id]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `cross:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function publicReceipt(receipt: HostChatReceipt | null, id: string) {
  if (!receipt) return null;
  const review = receipt.status === "awaiting_cost_approval"
    ? useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === receipt.requestId)?.costReview : undefined;
  return {
    ...receipt, requestId: id, message_id: receipt.requestId,
    ...(receipt.status === "awaiting_cost_approval" ? {
      submitted_to_model: false,
      cost_review: review,
      next_action: "A human must approve or cancel in the chat's cost review card. Do not poll continuously or resend with a new request_id.",
    } : {}),
  };
}

/** A finished UI turn can precede retirement of its Claude child process.
 * Keep that process fence in this native core, without widening plugin access. */
export function guardClaudeProcess(host: HostChatFacade, deps = {
  running: (sessionId: string) => invoke<boolean>("host_chat_is_running", { sessionId }),
  ended: (callback: (event: { runId: string }) => void) =>
    listen<{ runId: string }>("host-chat://process-retired", ({ payload }) => callback(payload)),
}): HostChatFacade {
  const key = (target: { engine: string; workspacePath: string; nativeSessionId?: string; sessionId?: string | null }) =>
    JSON.stringify([target.engine, target.nativeSessionId ?? target.sessionId, target.workspacePath]);
  const busy = new Set<string>();
  let generation = 0;
  let endedReady: Promise<() => void> | undefined;
  let disposed = false;
  const inspect: HostChatFacade["inspect"] = (target, options) => {
    const session = host.inspect(target, options);
    return session && busy.has(key(target)) && session.status === "idle" ? { ...session, status: "busy" } : session;
  };
  const beforeIdleSend: NonNullable<HostChatFacade["beforeIdleSend"]> = async target => {
    await host.beforeIdleSend?.(target);
    if (target.engine !== "claude") return;
    if (!endedReady) throw new Error("Native process guard is not subscribed");
    await endedReady;
    const identity = key(target);
    while (!disposed) {
      const observedGeneration = generation;
      const running = await deps.running(target.nativeSessionId);
      if (disposed) throw new Error("Native process guard has been disposed");
      if (observedGeneration !== generation) continue;
      if (running) { busy.add(identity); throw new HostChatBusyError(); }
      busy.delete(identity);
      return;
    }
    throw new Error("Native process guard has been disposed");
  };
  return {
    ...host, inspect, beforeIdleSend,
    current: () => { const current = host.current(); return current ? inspect(current) : null; },
    subscribe(callback) {
      const offHost = host.subscribe(callback);
      endedReady = deps.ended(() => {
        if (disposed) return;
        // A plugin/mission child has no chat capability or trusted sender,
        // but can still own a target's process. Invalidate, then re-probe.
        generation++;
        busy.clear();
        callback();
      });
      // Listen failure is observed by send too, and fences native submission.
      void endedReady.catch(() => { console.error("[host-chat] process retirement subscription unavailable"); });
      return () => {
        disposed = true; offHost();
        void endedReady?.then((off) => off(), () => {});
      };
    },
    async ready() {
      await host.ready?.();
      if (!endedReady) throw new Error("Native process guard is not subscribed");
      await endedReady;
      if (disposed) throw new Error("Native process guard has been disposed");
    },
    async send(target, prompt, runId, options) {
      await beforeIdleSend(target);
      if (disposed) throw new Error("Native process guard has been disposed");
      return host.send(target, prompt, runId, options);
    },
  };
}

/** Host-owned preparation sits outside the plugin's open/loaded-only bridge. */
export function createCrossSessionHandler(deps: Dependencies) {
  const preparing = new Map<string, Promise<unknown>>();
  const serialRequest = async (id: string, work: () => Promise<unknown>) => {
    const prior = preparing.get(id);
    const next = (prior ?? Promise.resolve()).catch(() => {}).then(work);
    preparing.set(id, next);
    try { return await next; }
    finally { if (preparing.get(id) === next) preparing.delete(id); }
  };
  const assertActive = () => { if (deps.isActive && !deps.isActive()) throw new Error("Host chat runtime has been disposed"); };
  const callerOf = (request: CrossSessionRequest): InboxCaller => ({ runId: requiredString(request.sender?.runId, "sender run identity"),
    engine: requiredString(request.sender?.engine, "sender engine"), sessionId: requiredString(request.sender?.sessionId, "sender session identity"),
    workspacePath: requiredString(request.sender?.workspacePath, "sender workspace") });
  const inboxNotice = async (caller: InboxCaller): Promise<{ inbox?: InboxSummary }> => {
    const inbox = await deps.bridge.inboxStatus?.(caller);
    assertActive();
    return inbox && (inbox.pending || inbox.held || inbox.needsReconciliation || inbox.waitingOnCaller?.length) ? { inbox } : {};
  };
  const existingScopedId = async (caller: InboxCaller, id: string, fallback: string): Promise<string> => {
    const known = await deps.bridge.findCorrespondence?.(caller, id);
    if (known) return known.requestId;
    // Preserve pre-inbox request hashes from the existing activity checkpoint.
    const matches = useCrossSessionActivityStore.getState().records.filter(record => record.requestId === id && sameParticipant(record.sender, caller));
    const receipts = (await Promise.all(matches.map(record => deps.bridge.receipt(record.scopedId)))).filter(receipt => receipt !== null);
    if (receipts.length > 1) throw new Error("Correspondence identity is ambiguous; reconcile existing receipts before retrying");
    return receipts[0]?.requestId ?? fallback;
  };
  deps.bridge.onEvent?.((receipt) => {
    if (!deps.isActive || deps.isActive()) {
      useCrossSessionActivityStore.getState().applyReceipt(receipt);
    }
  });
  async function catalog() {
    const rows = await deps.catalog();
    const archived = new Set(rows.archived.map((s) => sessionKey(s.engine, s.sessionId, s.workspacePath)));
    return rows.sessions.filter((s) => !s.remote && !archived.has(sessionKey(s.engine, s.sessionId, s.workspacePath)) &&
      !deps.store.getState().archivedSessionKeys[sessionKey(s.engine, s.sessionId, s.workspacePath)] &&
      rows.workspaces.some((w) => workspaceCatalogPathKey(w.path) === workspaceCatalogPathKey(s.workspacePath) && !(w.meta && "wsl" in w.meta)));
  }
  return async (request: CrossSessionRequest): Promise<unknown> => {
    assertActive();
    const args = request.arguments ?? {};
    if (["get_inbox_status", "read_messages", "acknowledge_message"].includes(request.method)) {
      const caller = callerOf(request);
      if (request.method === "get_inbox_status") {
        if (Object.keys(args).length) throw new Error("Inbox status does not accept identity overrides");
        return await deps.bridge.inboxStatus?.(caller) ?? { pending: 0, held: 0, needsReconciliation: 0 };
      }
      if (request.method === "read_messages") {
        if (!deps.bridge.readMessages || Object.keys(args).some(key => !["request_id", "limit", "message_ids"].includes(key))) throw new Error("Invalid inbox read arguments or unavailable inbox capability");
        const result = await deps.bridge.readMessages(caller, { requestId: requestId(args.request_id),
          ...(args.limit == null ? {} : { limit: args.limit as number }), ...(args.message_ids == null ? {} : { messageIds: args.message_ids as string[] }) });
        assertActive(); return result;
      }
      if (!deps.bridge.acknowledgeMessage || Object.keys(args).some(key => !["message_id", "read_request_id", "outcome", "response", "impact_review"].includes(key))) throw new Error("Invalid inbox acknowledgement arguments or unavailable inbox capability");
      const receipt = await deps.bridge.acknowledgeMessage(caller, requiredString(args.message_id, "message_id"), {
        readRequestId: requestId(args.read_request_id), outcome: args.outcome as "handled" | "deferred",
        ...(args.response == null ? {} : { response: args.response as string }), ...(args.impact_review == null ? {} : { impactReview: args.impact_review as string }) });
      assertActive(); useCrossSessionActivityStore.getState().applyReceipt(receipt);
      return { receipt, ...await inboxNotice(caller) };
    }
    if (request.method === "list_chats") {
      if (args.query !== undefined && typeof args.query !== "string") throw new Error("Invalid query");
      const query = (args.query as string | undefined)?.toLocaleLowerCase() ?? "";
      const limit = args.limit === undefined ? 50 : args.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer from 1 to 200");
      const rows = await catalog();
      assertActive();
      return { chats: rows.filter((s) => !query || `${s.customTitle ?? s.title}\n${s.engine}\n${s.sessionId}\n${s.engine}/${s.sessionId}\n${s.workspacePath}`.toLocaleLowerCase().includes(query))
        .slice(0, limit).map((s) => {
          const state = deps.store.getState().bySession[sessionKey(s.engine, s.sessionId, s.workspacePath)];
          const awaiting = state?.messages.some((m) => m.question?.status === "pending" || m.grant?.status === "pending" ||
            ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""));
          const status = awaiting ? "awaiting_permission" : state?.streaming || state?.queue.length ? "busy" : "idle";
          const hasUpdatedAt = typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt) && s.updatedAt > 0;
          const idleSeconds = status === "busy" ? 0 : hasUpdatedAt ? Math.max(0, Math.floor((Date.now() - s.updatedAt!) / 1000)) : undefined;
          const cache = promptCacheForEngine(s.engine, s.promptCache);
          const cacheWarmth = getSessionCacheHeat(cache);
          return {
            engine: s.engine,
            session_id: s.sessionId,
            workspace_path: s.workspacePath,
            title: s.customTitle ?? s.title,
            status,
            ...(hasUpdatedAt ? { idle_seconds: idleSeconds } : {}),
            cache_warmth: cacheWarmth,
            ...(cache ? { cache_retention_seconds: cache.ttlSeconds, cache_evidence: cache.source,
              ...(cache.reference ? { cache_reference: true, cache_retention_max_seconds: cache.reference.maxTtlSeconds, last_cache_read_tokens: cache.reference.cacheReadTokens } : {}),
            } : {}),
          };
        }) };
    }
    if (request.method !== "send_message" && request.method !== "get_message_status") throw new Error("Unknown host chat method");
    const id = requestId(args.request_id);
    const wait = waitSeconds(args.wait_seconds);
    const rawScoped = await scopedId(request.sender, id);
    const caller = callerOf(request);
    assertActive();
    if (request.method === "get_message_status") {
      const scoped = await existingScopedId(caller, id, rawScoped);
      const initial = await deps.bridge.receipt(scoped);
      assertActive();
      const notice = await inboxNotice(caller);
      const settled = await waitForReceipt(deps.bridge, scoped, initial, notice.inbox?.pending || notice.inbox?.waitingOnCaller?.length ? 0 : wait, assertActive, caller);
      if (settled) useCrossSessionActivityStore.getState().applyReceipt(settled);
      return { receipt: publicReceipt(settled, id), ...await inboxNotice(caller) };
    }
    const serializationKey = await scopedId({ ...request.sender, workspacePath: workspaceCatalogPathKey(caller.workspacePath) }, id);
    return serialRequest(serializationKey, async () => {
    assertActive();
    const scoped = await existingScopedId(caller, id, rawScoped);
    const sessionId = requiredString(args.session_id, "session_id");
    const message = requiredString(args.message, "message");
    if (message.length > 130_000) throw new Error("message exceeds 130000 characters");
    const engine = args.engine === undefined ? undefined : requiredString(args.engine, "engine");
    const workspace = args.workspace_path === undefined ? undefined : requiredString(args.workspace_path, "workspace_path");
    const updateOf = args.update_of == null ? undefined : requestId(args.update_of), replyTo = args.reply_to == null ? undefined : requestId(args.reply_to);
    if (updateOf && replyTo) throw new Error("update_of and reply_to are mutually exclusive");
    const relatedId = updateOf ?? replyTo;
    if (args.message_kind != null && (!relatedId || !["information", "constraint", "correction"].includes(args.message_kind as string))) throw new Error("message_kind requires a valid associated message");
    if (relatedId && !deps.bridge.submitCorrespondence) throw new Error("Associated inbox capability is unavailable");
    const rows = await catalog();
    assertActive();
    const scopedRows = rows.filter((s) => (!engine || s.engine === engine) && (!workspace || workspaceCatalogPathKey(s.workspacePath) === workspaceCatalogPathKey(workspace)));
    const exact = scopedRows.filter((s) => s.sessionId === sessionId);
    const matches = exact.length ? exact : sessionId.length >= 8 ? scopedRows.filter((s) => s.sessionId.startsWith(sessionId)) : [];
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous session_id; specify exact engine and workspace" : "Unknown or unavailable local session_id");
    const meta = matches[0];
    if (request.managedParent && !sameParticipant(request.managedParent, meta)) {
      throw new Error("Resolved target does not match the native task parent");
    }
    if (rows.filter((s) => s.engine === meta.engine && s.sessionId === meta.sessionId).length !== 1) throw new Error("Conflicting native session identities across workspaces");
    if (meta.engine === request.sender.engine && meta.sessionId === request.sender.sessionId) throw new Error("Cannot send a message to the sender's own session");
    const prompt = `[Message from CC GUI ${JSON.stringify({ engine: request.sender.engine, session_id: request.sender.sessionId })}]\n\n${message}`;
    if (prompt.length > 131_072) throw new Error("Attributed message exceeds host prompt limit");
    const target: HostChatTarget = { client: "ccgui", engine: meta.engine, nativeSessionId: meta.sessionId, guiSessionId: meta.sessionId,
      workspacePath: meta.workspacePath, ...await deps.bridge.identity() };
    const envelope: CorrespondenceEnvelope = { sender: { engine: caller.engine, sessionId: caller.sessionId, workspacePath: caller.workspacePath }, requestId: id,
      ...(request.managedParent && !relatedId ? { managedParent: request.managedParent } : {}),
      ...(relatedId ? { relation: { type: updateOf ? "update" : "reply", requestId: relatedId,
        scopedId: await scopedId(updateOf ? request.sender : { ...request.sender, engine: meta.engine, sessionId: meta.sessionId, workspacePath: meta.workspacePath }, relatedId) },
        kind: (args.message_kind ?? "information") as InboxMessageKind } : {}) };
    const senderMeta = rows.find((s) => s.engine === request.sender.engine && s.sessionId === request.sender.sessionId);
    const existingReceipt = await deps.bridge.receipt(scoped);
    assertActive();
    if (existingReceipt) {
      // Validate the original target+prompt before touching the visible card.
      // Retrying never approves a held request or replaces the approved text.
      const previous = await (deps.bridge.submitCorrespondence?.({ requestId: scoped, target, prompt }, envelope) ?? deps.bridge.submit({ requestId: scoped, target, prompt }));
      const notice = await inboxNotice(caller);
      const settled = await waitForReceipt(deps.bridge, scoped, previous, notice.inbox?.pending || notice.inbox?.waitingOnCaller?.length ? 0 : wait, assertActive, caller);
      if (settled) useCrossSessionActivityStore.getState().applyReceipt(settled);
      return { ...publicReceipt(settled, id), ...await inboxNotice(caller) };
    }
    const now = Date.now();
    useCrossSessionActivityStore.getState().upsertRecord({
      scopedId: scoped,
      requestId: id,
      sender: {
        engine: request.sender.engine,
        sessionId: request.sender.sessionId!,
        workspacePath: request.sender.workspacePath,
        title: senderMeta ? (senderMeta.customTitle ?? senderMeta.title) : undefined,
      },
      target: {
        engine: meta.engine,
        sessionId: meta.sessionId,
        workspacePath: meta.workspacePath,
        title: meta.customTitle ?? meta.title,
      },
      message,
      status: "preparing",
      acceptedAt: now,
      updatedAt: now,
      ...(envelope.relation ? { mailbox: { phase: "received", relation: envelope.relation.type, parentRequestId: envelope.relation.requestId, kind: envelope.kind! } as InboxReceiptState } : {}),
      ...(envelope.managedParent ? { mailbox: { phase: "received", relation: "task", parentRequestId: id, kind: "information" } as InboxReceiptState } : {}),
    });
    try {
      if (!deps.store.getState().initialized) await deps.store.getState().init();
      assertActive();
      // This is a local history read only. It supplies the last measured context
      // sample for review; no upstream model starts until the held entry is approved.
      await deps.store.getState().selectSession(meta.engine, meta.sessionId, meta.workspacePath, { background: true, meta });
      assertActive();
      const inspected = await deps.bridge.inspect(target);
      if (!inspected) throw new Error("Exact target is unavailable after history preparation");
      const sampleReview = (catalogMeta: SessionMeta, targetStatus: CrossSessionCostReview["targetStatus"]) => {
        const state = deps.store.getState();
        const stateMeta = state.sessions?.find((s) => s.engine === meta.engine && s.sessionId === meta.sessionId && s.workspacePath === meta.workspacePath);
        const latestMeta = !stateMeta ? catalogMeta : !catalogMeta.promptCache ? { ...stateMeta, promptCache: null }
          : !stateMeta.promptCache || catalogMeta.promptCache.observedAt >= stateMeta.promptCache.observedAt
            ? { ...stateMeta, promptCache: catalogMeta.promptCache } : stateMeta;
        const nextReview = crossSessionCostReview(latestMeta, state, targetStatus);
        const currentRecord = useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === scoped);
        if (currentRecord) useCrossSessionActivityStore.getState().upsertRecord({ ...currentRecord, costReview: nextReview });
        return nextReview;
      };
      const review = sampleReview(meta, inspected.status);
      assertActive();
      const submission = { requestId: scoped, target, prompt };
      const checkCost = async () => {
        const freshRows = await catalog().catch(() => null);
        const freshMeta = freshRows?.find((s) => s.engine === meta.engine && s.sessionId === meta.sessionId && s.workspacePath === meta.workspacePath) ?? meta;
        const current = await deps.bridge.inspect(target);
        const latest = sampleReview(freshMeta, current?.status ?? "idle");
        return requiresCrossSessionCostApproval(latest);
      };
      const submitted = await (deps.bridge.submitCorrespondence
        ? deps.bridge.submitCorrespondence(submission, envelope, { requiresCostApproval: requiresCrossSessionCostApproval(review), costGuard: true, reviewedModel: review.model ?? null, checkCost })
        : requiresCrossSessionCostApproval(review)
        ? deps.bridge.submitForCostApproval(submission)
        : deps.bridge.submitWithCostGuard(submission, review.model ?? null, checkCost));
      useCrossSessionActivityStore.getState().applyReceipt(submitted);
      assertActive();
      const notice = await inboxNotice(caller);
      const settled = await waitForReceipt(deps.bridge, scoped, submitted, notice.inbox?.pending || notice.inbox?.waitingOnCaller?.length ? 0 : wait, assertActive, caller);
      if (settled) useCrossSessionActivityStore.getState().applyReceipt(settled);
      return { ...publicReceipt(settled, id), ...await inboxNotice(caller) };
    } catch (error) {
      useCrossSessionActivityStore.getState().markFailed(scoped, error instanceof Error ? error.message : String(error));
      throw error;
    }
    });
  };
}

type CrossSessionQueueControls = Pick<ReturnType<typeof createHostChatBridge>, "prioritize" | "cancel">;
let queueControls: (CrossSessionQueueControls & Pick<ReturnType<typeof createHostChatBridge>, "approveCost">) | undefined;

/** Only a human UI action calls this host-only control. The MCP tool and the
 * plugin facade cannot acknowledge or bypass the approval. Busy targets queue. */
export async function approveCrossSessionMessage(
  scopedId: string,
  controls: Pick<ReturnType<typeof createHostChatBridge>, "approveCost"> | undefined = queueControls,
  reviewedModel?: string | null,
): Promise<void> {
  if (!controls) throw new Error("Host chat runtime is unavailable");
  const receipt = await controls.approveCost(scopedId, reviewedModel);
  if (!receipt) throw new Error("Cost approval request is unavailable");
  useCrossSessionActivityStore.getState().applyReceipt(receipt);
}

/** The target chat's user sends a waiting cross-session message now: it goes
 *  ahead of the chat's own queued rows, and a turn in flight is stopped the
 *  way Stop does (the composer queue stays parked), so the bridge delivers it
 *  under its original request identity and the sender can still follow it. */
export async function sendCrossSessionMessageNow(
  scopedId: string,
  controls: CrossSessionQueueControls | undefined = queueControls,
  store: { getState(): ChatStore } = useChatStore,
): Promise<void> {
  if (!controls) throw new Error("Host chat runtime is unavailable");
  const receipt = await controls.prioritize(scopedId);
  if (!receipt) return;
  useCrossSessionActivityStore.getState().applyReceipt(receipt);
  if (receipt.status !== "queued" && receipt.status !== "received") return;
  const { engine, nativeSessionId: sessionId, workspacePath } = receipt.target;
  if (store.getState().bySession[sessionKey(engine, sessionId, workspacePath)]?.streaming) {
    await store.getState().interrupt({ engine, sessionId, workspacePath });
  }
}

/** Withdraw a cross-session message that has not reached its target yet. */
export async function cancelCrossSessionMessage(
  scopedId: string,
  controls: CrossSessionQueueControls | undefined = queueControls,
): Promise<void> {
  if (!controls) throw new Error("Host chat runtime is unavailable");
  const receipt = await controls.cancel(scopedId);
  if (receipt) useCrossSessionActivityStore.getState().applyReceipt(receipt);
}

// Serial readiness changes prevent StrictMode/re-mount startup acknowledgements
// from racing an old cleanup and disabling the new subscription.
let readinessOwner: symbol | undefined;
let readinessChain: Promise<unknown> = Promise.resolve();
export function startCrossSessionRuntime(): () => void {
  if (isWeb) return () => {};
  const owner = Symbol();
  readinessOwner = owner;
  let disposed = false;
  let off: (() => void) | undefined;
  const initialized = Promise.withResolvers<void>();
  // The bootstrap participant observes this rejection. Also handle disposal
  // before bootstrap begins waiting, so StrictMode does not leak a rejection.
  void initialized.promise.catch(() => {});
  let managedHost: HostChatFacade | undefined;
  const bridge = createHostChatBridge("ccgui-cross-session", storage, {
    host: async () => (managedHost = guardClaudeProcess(await desktopChatFacade())), checkpointReady: () => initialized.promise,
    managedParent: async () => createManagedParentDelivery(async target => {
      if (!managedHost?.beforeIdleSend) throw new HostChatBusyError("Native parent process guard is unavailable");
      await managedHost.beforeIdleSend(target);
    }),
  });
  queueControls = bridge;
  const handler = createCrossSessionHandler({ store: useChatStore, bridge,
    isActive: () => !disposed,
    catalog: async () => {
      const [sessions, archived, workspaces] = await Promise.all([ipc.listSessions(), ipc.listArchivedSessions(), ipc.listWorkspaces()]);
      return { sessions, archived, workspaces };
    },
  });
  const ready = (value: boolean) => {
    readinessChain = readinessChain.catch(() => {}).then(async () => {
      if (readinessOwner === owner && (!value || !disposed)) await invoke("host_chat_ready", { ready: value });
    });
    return readinessChain;
  };
  void listen<CrossSessionRequest>("host-chat://request", ({ payload }) => {
    if (disposed) return;
    const response = isWorkspaceOrganizationMethod(payload.method)
      ? handleWorkspaceOrganizationRequest(payload, () => !disposed)
      : isPluginManagementMethod(payload.method)
      ? handlePluginManagementRequest(payload, () => !disposed)
      : handler(payload);
    void response.then((result) => invoke("host_chat_respond", { requestId: payload.requestId, result, error: null }),
      (error: unknown) => invoke("host_chat_respond", { requestId: payload.requestId, result: null, error: String(error) }))
      .catch(() => { console.error("[host-chat] response transport failed"); });
  }).then(async (unlisten) => {
    if (disposed) { unlisten(); return; }
    off = unlisten;
    await bridge.ready();
    if (disposed) return;
    // During handoff the native relay stays frozen until native commit. Ready
    // attests the restored handler/listeners/ledger, not permission to dispatch.
    await ready(true);
    initialized.resolve();
  }).catch((error: unknown) => { initialized.reject(error); if (!disposed) console.error("[host-chat] request subscription unavailable"); });
  return () => {
    disposed = true;
    if (queueControls === bridge) queueControls = undefined;
    initialized.reject(new Error("Host chat runtime has been disposed"));
    off?.();
    bridge.dispose();
    void ready(false).catch(() => { console.error("[host-chat] readiness cleanup failed"); });
  };
}
