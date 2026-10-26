import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isWeb, pauseWorkerEvents, resumeWorkerEvents } from "@/lib/transport";
import {
  abortRuntimeCheckpoint,
  getRuntimeCheckpointReadiness,
  prepareRuntimeCheckpoint,
} from "@/lib/runtime-checkpoint";
import { IS_CUSTOM_DISTRIBUTION } from "@/version/distribution";
import { canClosePluginViewsForUpdate, preparePluginViewsForUpdate, resumePluginViewsAfterUpdate } from "@/features/plugins/runtime/update-close";

export type LiveUpdatePhase = "Preparing" | "Ready" | "Activating" | "Committed" | "RolledBack" | "Failed";
export interface LiveUpdateIdentity {
  manifestSha256: string;
  channel: "protected-custom";
  releaseId: string;
  version: string;
  workerProtocol: number;
  checkpointSchema: number;
  schemaHash: string;
  executable: string;
}
export interface LiveUpdateTransaction {
  id: string;
  phase: LiveUpdatePhase;
  candidate: LiveUpdateIdentity;
  previous: LiveUpdateIdentity | null;
  failureReason?: string | null;
}
export interface LiveUpdateChannelChange {
  id: string;
  changeId: string;
  summary: string;
  sourceRoot: string;
  revision?: string;
}
export interface LiveUpdateChannel {
  version: number;
  working?: LiveUpdateChannelChange[];
  ready: LiveUpdateChannelChange[];
  updateRequest?: {
    id: string;
    requestId: string;
    sourceRoot: string;
    targetChangeIds: string[];
    waitingFor: string[];
  } | null;
  batch?: {
    id: string;
    requestId: string;
    sourceRoot: string;
    phase: string;
    changes: LiveUpdateChannelChange[];
    manifestSha256?: string | null;
    transactionId?: string | null;
    error?: string | null;
    autoBuild?: boolean;
  } | null;
  defaultSourceRoot?: string | null;
}
export interface LiveUpdateStatus {
  supported: boolean;
  state: { stateVersion: number; active: LiveUpdateIdentity | null; transaction: LiveUpdateTransaction | null };
  channel?: LiveUpdateChannel;
  blockers: string[];
  blockerDetails?: LiveUpdateBlockerDetail[];
  pendingHandoff: boolean;
}
export type LiveUpdateBlockerState = "starting" | "stopping" | "reader-finished" | "registered" | "registry-unavailable";
export interface LiveUpdateBlockerDetail {
  reason: string;
  runId?: string;
  engine?: string;
  sessionId?: string;
  pluginId?: string;
  state?: LiveUpdateBlockerState;
}
export interface LiveUpdateBlocker extends LiveUpdateBlockerDetail { participant?: string; detail?: string }
export type LiveUpdateErrorCode = "invalidInput" | "statusFailed" | "stageFailed" | "switchFailed" | "recoveryFailed" | "previousFailed";
export interface LiveUpdateState {
  support: "checking" | "supported" | "unsupported" | "web" | "not-custom";
  stage: "idle" | "importing" | "waiting" | "applying" | "cancelling" | "handoff" | "error";
  checking: boolean;
  active: LiveUpdateIdentity | null;
  transaction: LiveUpdateTransaction | null;
  channel: LiveUpdateChannel | null;
  blockers: LiveUpdateBlocker[];
  canCancel: boolean;
  cancelled: boolean;
  errorCode?: LiveUpdateErrorCode;
  error?: string;
  recoveryError?: string;
  requesting: boolean;
  requestError?: string;
  requestUpdate: (sourceRoot?: string) => Promise<void>;
  watch: () => () => void;
  refresh: () => Promise<void>;
  stagePackage: (source: string, manifestSha256: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Application teardown/HMR only; closing settings keeps a queued update alive. */
  dispose: () => void;
}

export interface LiveUpdateDependencies {
  native: typeof invoke;
  web: boolean;
  custom: boolean;
  readiness: typeof getRuntimeCheckpointReadiness;
  pauseEvents: typeof pauseWorkerEvents;
  prepareCheckpoint: typeof prepareRuntimeCheckpoint;
  abortCheckpoint: typeof abortRuntimeCheckpoint;
  resumeEvents: typeof resumeWorkerEvents;
  canClosePluginViews?: (blockers: readonly LiveUpdateBlocker[]) => boolean;
  preparePluginViews?: (signal: AbortSignal) => Promise<void>;
  resumePluginViews?: () => void;
}

const POLL_MS = 3_000;
const ERROR_POLL_MS = 10_000;
const VIEW_PREPARE_TIMEOUT_MS = 45_000;
class PluginViewPreparationError extends Error {
  constructor(readonly reason: string, readonly detail?: string) { super(reason); }
}
const eligible = (transaction: LiveUpdateTransaction | null) => transaction?.phase === "Preparing" || transaction?.phase === "Ready";
const busyBatchPhases = ["Building", "Staging", "Preparing", "Ready", "Activating"];

export function canRequestSelfUpdate(state: LiveUpdateState, sourceRoot?: string | null): boolean {
  const hasQueued = (state.channel?.ready.length ?? 0) + (state.channel?.working?.length ?? 0) > 0;
  const hasSource = Boolean(sourceRoot && sourceRoot.trim().length > 0);
  return state.support === "supported" && !state.requesting
    && ["idle", "error"].includes(state.stage) && state.errorCode !== "recoveryFailed"
    && !eligible(state.transaction) && state.transaction?.phase !== "Activating"
    && !state.channel?.updateRequest && !busyBatchPhases.includes(state.channel?.batch?.phase ?? "")
    && (hasQueued || hasSource);
}
const message = (error: unknown): string => error instanceof Error ? error.message
  : typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error);
const missingCommand = (error: unknown) => /(?:unknown|unrecognized|unsupported|not found|not registered|does not exist).*command|command.*(?:unknown|not found|not registered|does not exist)/i.test(message(error));

function validTransaction(value: unknown): value is LiveUpdateTransaction {
  if (!value || typeof value !== "object") return false;
  const transaction = value as LiveUpdateTransaction;
  return typeof transaction.id === "string" && transaction.id.length > 0
    && ["Preparing", "Ready", "Activating", "Committed", "RolledBack", "Failed"].includes(transaction.phase)
    && transaction.candidate?.channel === "protected-custom" && typeof transaction.candidate.version === "string";
}

/** Details enrich the authoritative reason list; they can never clear a blocker. */
function nativeBlockers(reasons: string[], details: unknown): LiveUpdateBlocker[] {
  const byReason = new Map<string, LiveUpdateBlockerDetail[]>();
  if (Array.isArray(details)) {
    const seen = new Set<string>();
    for (const value of details) {
      if (!value || typeof value !== "object" || !reasons.includes(value.reason)) continue;
      const invalid = [value.runId, value.engine, value.sessionId].some(field => field !== undefined
        && (typeof field !== "string" || !field.trim() || field.length > 256 || /[\u0000-\u001f\u007f]/.test(field)))
        || (value.pluginId !== undefined && (typeof value.pluginId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value.pluginId)))
        || (value.state !== undefined && !["starting", "stopping", "reader-finished", "registered", "registry-unavailable"].includes(value.state));
      if (invalid) {
        // Malformed service metadata must never be hidden by another valid owner.
        if (value.reason === "plugin-processes") {
          const matches = byReason.get(value.reason) ?? [];
          matches.push({ reason: value.reason }); byReason.set(value.reason, matches);
        }
        continue;
      }
      const detail: LiveUpdateBlockerDetail = { reason: value.reason };
      if (value.runId !== undefined) detail.runId = value.runId;
      if (value.engine !== undefined) detail.engine = value.engine;
      if (value.sessionId !== undefined) detail.sessionId = value.sessionId;
      if (value.pluginId !== undefined) detail.pluginId = value.pluginId;
      if (value.state !== undefined) detail.state = value.state;
      const key = JSON.stringify(detail);
      if (seen.has(key)) continue;
      seen.add(key);
      const matches = byReason.get(detail.reason) ?? [];
      matches.push(detail);
      byReason.set(detail.reason, matches);
    }
  }
  return reasons.flatMap(reason => byReason.get(reason) ?? [{ reason }]);
}

/** One coordinator per UI runtime. Status polling is read-only until a staged
 * transaction and both readiness checks allow its already-authorized handoff. */
export function createLiveUpdateStore(deps: LiveUpdateDependencies) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchers = 0;
  let disposed = false;
  let revision = 0;
  let reading: Promise<void> | null = null;
  let operation: Promise<void> | null = null;
  let cancelRequested = false;
  let activationSent = false;
  let autoApply = true;
  let failedTransactionId: string | undefined;
  // Keep the same id after an uncertain reply so native retries are idempotent.
  let requestId: string | undefined;
  let viewPreparation: AbortController | undefined;

  const store = create<LiveUpdateState>(() => ({
    support: !deps.custom ? "not-custom" : deps.web ? "web" : "checking",
    stage: "idle", checking: false, active: null, transaction: null, channel: null, blockers: [], canCancel: false, cancelled: false, requesting: false,
    async requestUpdate(sourceRoot?: string) {
      const trimmedSource = sourceRoot?.trim() || undefined;
      if (disposed || deps.web || !deps.custom || operation || !canRequestSelfUpdate(store.getState(), trimmedSource)) return;
      requestId ??= `ui-${crypto.randomUUID()}`;
      revision++;
      clearTimer();
      store.setState({ requesting: true, requestError: undefined, checking: false });
      operation = (async () => {
        try {
          const payload = trimmedSource ? { requestId, sourceRoot: trimmedSource } : { requestId };
          const reply = await deps.native<{ channel: LiveUpdateChannel }>("live_update_request", payload);
          if (!reply?.channel || !Array.isArray(reply.channel.ready)) throw new Error("Invalid self-update request reply");
          if (disposed) return;
          requestId = undefined;
          autoApply = true;
          failedTransactionId = undefined;
          store.setState({ channel: reply.channel, stage: "idle", errorCode: undefined, error: undefined, recoveryError: undefined, cancelled: false });
        } catch (error) {
          if (!disposed) store.setState({ requestError: message(error) });
        }
      })().finally(() => {
        operation = null;
        if (!disposed) store.setState({ requesting: false });
        schedule();
      });
      await operation;
    },
    watch() {
      watchers++;
      if (!disposed) void poll();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watchers = Math.max(0, watchers - 1);
        if (!watchers) {
          revision++;
          store.setState({ checking: false });
        }
        schedule();
      };
    },
    async refresh() {
      if (disposed || operation) return;
      // A failed cleanup needs an explicit cancel retry, not another activation.
      if (store.getState().errorCode !== "recoveryFailed") {
        autoApply = true;
        failedTransactionId = undefined;
        store.setState({ error: undefined, errorCode: undefined, recoveryError: undefined, cancelled: false });
      }
      await poll();
    },
    async stagePackage(source, manifestSha256) {
      if (disposed || deps.web || !deps.custom || operation || store.getState().support !== "supported") return;
      if (eligible(store.getState().transaction) || store.getState().stage === "handoff") return;
      const digest = manifestSha256.trim().toLowerCase();
      if (!source.trim() || !/^[a-f0-9]{64}$/.test(digest)) {
        store.setState({ stage: "error", errorCode: "invalidInput", error: undefined });
        return;
      }
      revision++;
      clearTimer();
      cancelRequested = false;
      activationSent = false;
      autoApply = true;
      failedTransactionId = undefined;
      store.setState({ stage: "importing", checking: false, canCancel: true, cancelled: false, blockers: [], error: undefined, errorCode: undefined, recoveryError: undefined });
      operation = (async () => {
        try {
          const transaction = await deps.native<LiveUpdateTransaction>("live_update_stage", { source: source.trim(), manifestSha256: digest });
          if (!validTransaction(transaction) || !eligible(transaction)) throw new Error("Invalid staged update transaction");
          store.setState({ transaction });
          if (cancelRequested || disposed) { await recover(transaction, undefined); return; }
          store.setState({ stage: "waiting", canCancel: true });
        } catch (error) {
          autoApply = false;
          store.setState({ stage: "error", canCancel: false, errorCode: "stageFailed", error: message(error) });
        }
      })().finally(() => {
        operation = null;
        if (!disposed && store.getState().stage === "waiting") void poll();
        else schedule();
      });
      await operation;
    },
    async cancel() {
      if (disposed || deps.web || !deps.custom || activationSent || !store.getState().canCancel) return;
      cancelRequested = true;
      viewPreparation?.abort();
      autoApply = false;
      revision++;
      clearTimer();
      store.setState({ stage: "cancelling", checking: false, canCancel: false });
      if (operation) { await operation; return; }
      const transaction = store.getState().transaction;
      if (!transaction) { store.setState({ stage: "idle", cancelled: true }); return; }
      operation = recover(transaction, undefined).finally(() => { operation = null; schedule(); });
      await operation;
    },
    dispose() {
      disposed = true;
      revision++;
      cancelRequested = true;
      viewPreparation?.abort();
      clearTimer();
    },
  }));

  function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule() {
    clearTimer();
    const state = store.getState();
    if (disposed || deps.web || !deps.custom || operation || reading || state.support === "unsupported" || state.stage === "handoff") return;
    if (!watchers) return;
    timer = setTimeout(() => { timer = undefined; void poll(); }, state.stage === "error" ? ERROR_POLL_MS : POLL_MS);
  }

  function transientWaitBlockers(cause: unknown): LiveUpdateBlocker[] | null {
    if (cause instanceof PluginViewPreparationError) {
      return [{ participant: "plugin-update-close", reason: cause.reason, detail: cause.detail }];
    }
    const text = message(cause);
    const runtimeMatch = /^Runtime checkpoint is blocked:\s*(.+)$/.exec(text);
    if (runtimeMatch) {
      return runtimeMatch[1].split(",").map(item => item.trim()).filter(Boolean).map(item => {
        const colon = item.indexOf(":");
        return colon > 0 ? { participant: item.slice(0, colon), reason: item.slice(colon + 1) } : { reason: item };
      });
    }
    const nativeMatch = /^Update is waiting:\s*(.+)$/.exec(text);
    if (nativeMatch) {
      return nativeMatch[1].split(",").map(reason => reason.trim()).filter(Boolean).map(reason => ({ reason }));
    }
    return null;
  }

  async function recover(transaction: LiveUpdateTransaction, cause: unknown | undefined) {
    const waitBlockers = cause !== undefined ? transientWaitBlockers(cause) : null;
    const recoveryErrors: string[] = [];
    let aborted = false;
    try {
      await deps.native("live_update_abort", waitBlockers ? { transactionId: transaction.id, defer: true } : { transactionId: transaction.id });
      aborted = true;
    } catch (error) { recoveryErrors.push(message(error)); }
    try { deps.abortCheckpoint(); } catch (error) { recoveryErrors.push(message(error)); }
    try { deps.resumePluginViews?.(); } catch (error) { recoveryErrors.push(message(error)); }
    try { await deps.resumeEvents(); } catch (error) { recoveryErrors.push(message(error)); }
    activationSent = false;
    cancelRequested = false;
    if (waitBlockers && recoveryErrors.length === 0) {
      store.setState({ stage: "waiting", transaction, blockers: waitBlockers, canCancel: true,
        errorCode: undefined, error: undefined, recoveryError: undefined });
      return;
    }
    autoApply = false;
    failedTransactionId = transaction.id;
    if (recoveryErrors.length) {
      store.setState({ stage: "error", transaction: aborted && !waitBlockers ? { ...transaction, phase: "Failed" } : transaction,
        canCancel: true, errorCode: "recoveryFailed", error: cause === undefined ? undefined : message(cause), recoveryError: recoveryErrors.join("; ") });
    } else if (cause !== undefined) {
      store.setState({ stage: "error", transaction: { ...transaction, phase: "Failed" }, canCancel: false,
        errorCode: "switchFailed", error: message(cause), recoveryError: undefined });
    } else {
      store.setState({ stage: "idle", transaction: null, blockers: [], canCancel: false, cancelled: true,
        errorCode: undefined, error: undefined, recoveryError: undefined });
    }
  }

  async function prepareViews() {
    const controller = new AbortController();
    viewPreparation = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, VIEW_PREPARE_TIMEOUT_MS);
    let onAbort: (() => void) | undefined;
    try {
      // Bound even a non-cooperative callback. The view registry also fences
      // each continuation so a late callback cannot close a newly edited tab.
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return deps.preparePluginViews!(controller.signal);
        }).then(resolve, reject);
      });
    } catch (error) {
      if (cancelRequested || disposed) throw error;
      throw new PluginViewPreparationError(timedOut ? "plugin-update-close-timeout" : "plugin-update-close-failed", timedOut ? undefined : message(error));
    } finally {
      clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      if (viewPreparation === controller) viewPreparation = undefined;
    }
  }

  function switchCandidate(transaction: LiveUpdateTransaction, nativeReasons: LiveUpdateBlocker[]) {
    if (operation || disposed || !autoApply) return;
    const initialBlockers = [...nativeReasons, ...deps.readiness().map(({ participant, reason }) => ({ participant, reason }))];
    const closeViews = initialBlockers.length > 0 && !!deps.preparePluginViews && deps.canClosePluginViews?.(initialBlockers) === true;
    if (initialBlockers.length > 0 && !closeViews) {
      store.setState({ stage: "waiting", canCancel: true, blockers: initialBlockers, error: undefined, errorCode: undefined });
      schedule();
      return;
    }
    revision++;
    clearTimer();
    cancelRequested = false;
    activationSent = false;
    store.setState({ stage: "applying", canCancel: true, blockers: [], error: undefined, errorCode: undefined });
    operation = (async () => {
      try {
        // Loaded opt-in controllers can keep background work even after their
        // views close, including after a deferred admission attempt.
        if (deps.preparePluginViews) await prepareViews();
        if (cancelRequested || disposed) { await recover(transaction, undefined); return; }
        const remaining = deps.readiness();
        if (remaining.length) throw new Error(`Runtime checkpoint is blocked: ${remaining.map(b => `${b.participant}:${b.reason}`).join(", ")}`);
        await deps.native("live_update_begin", { transactionId: transaction.id });
        if (cancelRequested || disposed) { await recover(transaction, undefined); return; }
        const cursors = await deps.pauseEvents();
        if (cancelRequested || disposed) { await recover(transaction, undefined); return; }
        const checkpoint = await deps.prepareCheckpoint();
        if (cancelRequested || disposed) { await recover(transaction, undefined); return; }
        activationSent = true;
        store.setState({ canCancel: false });
        await deps.native("live_update_activate", { transactionId: transaction.id, checkpoint, cursors });
        store.setState({ stage: "handoff", transaction: { ...transaction, phase: "Activating" }, canCancel: false });
      } catch (error) {
        await recover(transaction, cancelRequested || disposed ? undefined : error);
      }
    })().finally(() => { operation = null; schedule(); });
  }

  function poll(): Promise<void> {
    if (disposed || deps.web || !deps.custom || operation || store.getState().stage === "handoff") return Promise.resolve();
    if (reading) return reading;
    clearTimer();
    const ticket = revision;
    let ready: LiveUpdateTransaction | null = null;
    let nativeReasons: LiveUpdateBlocker[] = [];
    store.setState({ checking: true });
    reading = (async () => {
      try {
        const status = await deps.native<LiveUpdateStatus>("live_update_status");
        if (disposed || ticket !== revision) return;
        if (!status || status.supported !== true) {
          autoApply = false;
          store.setState({ support: "unsupported", canCancel: false });
          return;
        }
        if (!status.state || !Array.isArray(status.blockers) || !status.blockers.every(reason => typeof reason === "string")
          || typeof status.pendingHandoff !== "boolean" || (status.state.transaction !== null && !validTransaction(status.state.transaction))) {
          throw new Error("Invalid live update status");
        }
        const transaction = status.state.transaction;
        if (requestId && (status.channel?.updateRequest?.requestId === requestId || status.channel?.batch?.requestId === requestId)) {
          requestId = undefined;
          store.setState({ requestError: undefined });
        }
        nativeReasons = nativeBlockers(status.blockers, status.blockerDetails);
        const blockers: LiveUpdateBlocker[] = [
          ...nativeReasons,
          ...deps.readiness().map(({ participant, reason }) => ({ participant, reason })),
        ];
        if (store.getState().errorCode === "statusFailed") {
          store.setState({ errorCode: undefined, error: undefined });
          if (failedTransactionId === undefined) autoApply = true;
        }
        if (transaction && eligible(transaction) && transaction.id !== failedTransactionId && store.getState().errorCode !== "recoveryFailed") {
          failedTransactionId = undefined;
          autoApply = true;
          store.setState({ errorCode: undefined, error: undefined, cancelled: false });
        }
        store.setState({ support: "supported", active: status.state.active, transaction, channel: status.channel ?? null, blockers });
        if (status.pendingHandoff || transaction?.phase === "Activating") {
          autoApply = false;
          store.setState({ stage: "handoff", canCancel: false });
        } else if (eligible(transaction)) {
          if (store.getState().errorCode === undefined) store.setState({ stage: "waiting", canCancel: true });
          if (autoApply && store.getState().errorCode === undefined && (blockers.length === 0 ||
            (!!deps.preparePluginViews && deps.canClosePluginViews?.(blockers) === true))) ready = transaction;
        } else if (transaction?.phase === "Failed" || transaction?.phase === "RolledBack") {
          autoApply = false;
          failedTransactionId = transaction.id;
          if (!store.getState().cancelled && store.getState().errorCode === undefined) {
            store.setState({ stage: "error", canCancel: false, errorCode: "previousFailed", error: transaction.failureReason ?? undefined });
          }
        } else if (store.getState().errorCode === undefined) {
          if (transaction?.phase === "Committed") failedTransactionId = undefined;
          store.setState({ stage: "idle", canCancel: false });
        }
      } catch (error) {
        if (disposed || ticket !== revision) return;
        autoApply = false;
        if (missingCommand(error)) store.setState({ support: "unsupported", stage: "idle", canCancel: false });
        else store.setState({ stage: "error", errorCode: "statusFailed", error: message(error) });
      } finally {
        if (!disposed && ticket === revision) store.setState({ checking: false });
      }
    })().finally(() => {
      reading = null;
      if (ready && ticket === revision) switchCandidate(ready, nativeReasons);
      else schedule();
    });
    return reading;
  }

  return store;
}

export const useLiveUpdateStore = createLiveUpdateStore({
  native: invoke, web: isWeb, custom: IS_CUSTOM_DISTRIBUTION,
  readiness: () => getRuntimeCheckpointReadiness(), pauseEvents: () => pauseWorkerEvents(),
  prepareCheckpoint: () => prepareRuntimeCheckpoint(), abortCheckpoint: () => abortRuntimeCheckpoint(),
  resumeEvents: () => resumeWorkerEvents(),
  canClosePluginViews: canClosePluginViewsForUpdate,
  preparePluginViews: preparePluginViewsForUpdate,
  resumePluginViews: resumePluginViewsAfterUpdate,
});

/** Register once after bootstrap recovery has released native/UI ownership.
 * Settings mounting is unrelated to this application-lifetime subscription. */
export function startLiveUpdateRuntime(store = useLiveUpdateStore): () => void {
  if (["web", "not-custom"].includes(store.getState().support)) return () => {};
  return store.getState().watch();
}

if (import.meta.hot) import.meta.hot.dispose(() => useLiveUpdateStore.getState().dispose());
