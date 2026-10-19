import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { relayProfilePath } from "./relay-profile";
import { WorkerEventTransport, WorkerEventTransportError, type WorkerCursors, type WorkerEnvelopeIdentity } from "./worker-event-transport";

/**
 * Transport layer: identical invoke/listen surface as the Tauri IPC API, but
 * routed over the web-access WebSocket bridge when the app runs in a plain
 * browser (no __TAURI_INTERNALS__). See src-tauri/src/web.rs for the protocol.
 */
export const isWeb =
  typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

/** Token issued by the desktop on web-access start, carried in the URL. */
export const webToken: string | null = isWeb
  ? new URLSearchParams(window.location.search).get("token")
  : null;

type Listener = (payload: unknown) => void;

interface PendingReq {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  frame: string;
  command: string;
  replayable: boolean;
  sentOn: WebSocket | null;
  timeout?: ReturnType<typeof setTimeout>;
  requestId?: string;
}

const RETRY_MAX_MS = 10_000;
const WORKER_REQUEST_TIMEOUT_MS = 5 * 60_000;

export class TransportRequestError extends Error {
  constructor(readonly code: "request-uncertain" | "transport-disconnected", readonly command: string, readonly requestId?: string) {
    super(code === "request-uncertain" ? "Connection lost before the request outcome could be confirmed" : "Web bridge disconnected");
    this.name = "TransportRequestError";
  }
}

class WebBridge {
  private ws: WebSocket | null = null;
  private openGate: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private readySocket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingReq>();
  private listeners = new Map<string, Set<Listener>>();
  private retryMs = 1000;
  private versionValue: string | null = null;
  private versionWaiters: ((v: string | null) => void)[] = [];

  /** Connect if needed; resolves after the authenticated hello handshake. */
  private ensure(): Promise<void> {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return this.openGate!;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}${relayProfilePath("/ws")}?token=${encodeURIComponent(webToken ?? "")}`,
    );
    this.ws = ws;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.openGate = promise;
    this.openResolve = resolve;
    ws.onopen = () => {
      this.retryMs = 1000;
    };
    // Frames arrive as text through the relay only after the Worker learns the
    // frame type; until then they come back as bytes, and String(blob) is
    // "[object Blob]" — every response was being dropped on the floor.
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.onMessage(
        typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer),
      );
    };
    ws.onclose = () => this.onClose(ws);
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
    return promise;
  }

  private onMessage(text: string) {
    let msg: {
      type?: string;
      version?: string;
      id?: unknown;
      ok?: boolean;
      payload?: unknown;
      error?: unknown;
      name?: string;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (this.readySocket === this.ws) return;
      this.readySocket = this.ws;
      this.versionValue = typeof msg.version === "string" ? msg.version : null;
      this.openResolve?.();
      this.sendPending();
      for (const w of this.versionWaiters.splice(0)) w(this.versionValue);
      // Subscribers reload snapshots after every handshake, including reconnects
      // where state-change events may have been missed while offline.
      for (const cb of this.listeners.get("transport://connected") ?? []) cb(null);
      return;
    }
    if (msg.type === "response") {
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timeout);
      if (msg.ok) entry.resolve(msg.payload);
      else entry.reject(new Error(String(msg.error ?? "unknown error")));
      return;
    }
    if (msg.type === "event" && typeof msg.name === "string") {
      const subs = this.listeners.get(msg.name);
      if (subs) for (const cb of subs) cb(msg.payload);
    }
  }

  private onClose(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.readySocket = null;
    this.openGate = null;
    // Release waiters parked in ensure(); invoke re-checks readyState and
    // throws instead of hanging when the socket never opened.
    this.openResolve?.();
    this.openResolve = null;
    for (const [id, entry] of this.pending) {
      if (entry.replayable) continue;
      this.pending.delete(id);
      entry.reject(new TransportRequestError(entry.sentOn ? "request-uncertain" : "transport-disconnected", entry.command, entry.requestId));
    }
    // If no hello ever arrived (e.g. wrong token → 403), release version
    // waiters so the About/status bar UI does not hang on "…".
    if (this.versionValue === null) {
      for (const w of this.versionWaiters.splice(0)) w(null);
    }
    // Keep retrying: the desktop may have restarted the bridge.
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    setTimeout(() => void this.ensure(), delay);
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const request = args?.request as Record<string, unknown> | undefined;
    const requestId = cmd === "runtime_worker_start" ? args?.runId : request?.requestId;
    const readOnlyWorkerRequest = ["runtime_worker_sources", "runtime_worker_events", "runtime_observer_snapshot"].includes(cmd);
    const replayable = readOnlyWorkerRequest || cmd === "runtime_worker_plan_review" ||
      (["runtime_worker_start", "runtime_worker_control"].includes(cmd) && typeof requestId === "string" && requestId.length > 0);
    const entry: PendingReq = {
      frame: JSON.stringify({ type: "invoke", id, cmd, args: args ?? {} }),
      command: cmd,
      replayable,
      sentOn: null,
      requestId: typeof requestId === "string" ? requestId : undefined,
      resolve: resolve as (v: unknown) => void,
      reject: (error) => {
        // These native commands return typed errors. The WS dispatch serializes
        // them inside its string error field; retain codes used for conflict,
        // rate-limit and permission feedback instead of degrading to "internal".
        if (["mcp_inventory", "mcp_set_enabled", "mcp_probe", "skills_hub_query", "skills_hub_mutate", "runtime_worker_start", "runtime_worker_control", "runtime_worker_plan_review"].includes(cmd)) {
          try {
            const typed: unknown = JSON.parse(error.message);
            if (typed && typeof typed === "object" && "code" in typed && "message" in typed &&
                typeof typed.code === "string" && typeof typed.message === "string") {
              reject(typed);
              return;
            }
          } catch { /* Ordinary transport failures remain Error objects. */ }
        }
        reject(error);
      },
    };
    if (replayable) {
      entry.timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        entry.reject(new TransportRequestError(entry.sentOn && !readOnlyWorkerRequest ? "request-uncertain" : "transport-disconnected", cmd, entry.requestId));
      }, WORKER_REQUEST_TIMEOUT_MS);
    }
    this.pending.set(id, entry);
    void this.ensure().then(() => this.sendPending()).catch(() => {
      if (!this.pending.delete(id)) return;
      clearTimeout(entry.timeout);
      entry.reject(new TransportRequestError(entry.sentOn && !readOnlyWorkerRequest ? "request-uncertain" : "transport-disconnected", cmd, entry.requestId));
    });
    return promise;
  }

  private sendPending(): void {
    const ws = this.ws;
    if (!ws || this.readySocket !== ws || ws.readyState !== WebSocket.OPEN) return;
    for (const entry of this.pending.values()) {
      if (entry.sentOn === ws) continue;
      try {
        ws.send(entry.frame);
        entry.sentOn = ws;
      } catch {
        // Keep stable worker requests for the next handshake; legacy outcomes
        // are rejected by onClose and must never be guessed or resubmitted.
        this.onClose(ws);
        return;
      }
    }
  }

  async listen(name: string, cb: Listener): Promise<UnlistenFn> {
    void this.ensure();
    let subs = this.listeners.get(name);
    if (!subs) {
      subs = new Set();
      this.listeners.set(name, subs);
    }
    subs.add(cb);
    return () => {
      const set = this.listeners.get(name);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(name);
    };
  }

  serverVersion(): Promise<string | null> {
    if (this.versionValue !== null) return Promise.resolve(this.versionValue);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    this.versionWaiters.push(resolve);
    void this.ensure();
    return promise;
  }
}

let bridge: WebBridge | null = null;
let workerSupport: boolean | undefined;
let workerProbe: Promise<boolean> | undefined;

function isMissingWorkerCommand(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return new RegExp(`(?:unknown|unrecognized)\\s+(?:ipc\\s+)?command[:\\s'\"]*${command}\\b|command\\s+['\"]?${command}['\"]?\\s+(?:was\\s+)?(?:not found|does not exist|is not registered)`, "i").test(message);
}

async function rawInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (workerSupport === false && cmd.startsWith("runtime_worker_")) throw new Error("Worker protocol is unavailable on this host");
  try {
    const value = await (!isWeb ? tauriInvoke<T>(cmd, args) : (bridge ??= new WebBridge()).invoke<T>(cmd, args));
    if (cmd === "runtime_worker_sources") workerSupport = true;
    return value;
  } catch (error) {
    if (cmd.startsWith("runtime_worker_") && cmd !== "runtime_worker_plan_review" && isMissingWorkerCommand(error, cmd)) {
      workerSupport = false;
      workerEvents?.dispose();
      workerEvents = undefined;
    }
    throw error;
  }
}

async function supportsWorkers(): Promise<boolean> {
  if (workerSupport !== undefined) return workerSupport;
  return workerProbe ??= rawInvoke("runtime_worker_sources").then(() => true).catch(error => {
    workerProbe = undefined;
    if (workerSupport === false) return false;
    throw error;
  });
}

function rawListen(name: string, cb: Listener): Promise<UnlistenFn> {
  if (!isWeb) return tauriListen<unknown>(name, event => cb(event.payload));
  return (bridge ??= new WebBridge()).listen(name, cb);
}

const publicListeners = new Map<string, Set<Listener>>();
let workerEvents: WorkerEventTransport | undefined;
let engineListenerReady: Promise<void> | undefined;
const deliveryReceipts = new Map<string, { name: string; callbacks: Listener[]; next: number }>();
let receiptCallbacks = 0;
const pendingRunAttachments = new Set<string>();
let attachmentRetry: ReturnType<typeof setTimeout> | undefined;
let attachingRuns: Promise<void> | undefined;

function deliver(name: string, payload: unknown, identity?: WorkerEnvelopeIdentity): void {
  if (!identity) { for (const cb of [...(publicListeners.get(name) ?? [])]) cb(payload); return; }
  const key = JSON.stringify([identity.streamId, identity.seq]);
  let receipt = deliveryReceipts.get(key);
  if (!receipt) {
    const callbacks = [...(publicListeners.get(name) ?? [])];
    if (deliveryReceipts.size >= 4096 || receiptCallbacks + callbacks.length > 16_384) {
      throw new WorkerEventTransportError("receipt-limit", "Worker delivery receipts exceeded their bound", identity.streamId);
    }
    receipt = { name, callbacks, next: 0 };
    deliveryReceipts.set(key, receipt);
    receiptCallbacks += callbacks.length;
  }
  if (receipt.name !== name) throw new WorkerEventTransportError("receipt-conflict", "Worker envelope identity changed", identity.streamId);
  // Each callback still must be atomic individually. Retrying a later callback
  // cannot repeat subscribers which have already committed this envelope.
  while (receipt.next < receipt.callbacks.length) {
    receipt.callbacks[receipt.next](payload);
    receipt.next++;
  }
  receiptCallbacks -= receipt.callbacks.length;
  deliveryReceipts.delete(key);
}

function reportWorkerError(code: string, message: string, streamId?: string): void {
  console.error("Worker event transport:", code, streamId ?? "");
  try { deliver("transport://worker-error", { code, message, streamId }); } catch { /* Reporting cannot turn an accepted send into a retry. */ }
}

function workers(): WorkerEventTransport {
  return workerEvents ??= new WorkerEventTransport({
    rawInvoke,
    rawListen,
    deliver,
    onError: error => {
      if (workerSupport === false) return; // Older installed hosts have no worker protocol.
      reportWorkerError(error.code, error.message, error.streamId);
    },
  });
}

/** Restore chat and these cursors together before registering engine listeners. */
export async function initializeWorkerEvents(cursors?: WorkerCursors): Promise<void> {
  const adapter = workers();
  if (cursors !== undefined) {
    adapter.restoreCursors(cursors);
    await adapter.pause();
  }
}

export async function pauseWorkerEvents(): Promise<WorkerCursors> {
  if (!workerEvents) return {};
  await workerEvents.pause();
  return workerEvents.captureCursors();
}

export function resumeWorkerEvents(): Promise<void> {
  if (workerSupport === false) return Promise.resolve();
  return workerEvents?.resume() ?? Promise.resolve();
}

export function getWorkerEventCursors(): WorkerCursors {
  return workerEvents?.captureCursors() ?? {};
}

/** Caller identifies runs represented by authoritative chat/checkpoint state. */
export async function attachRunSources(runIds: string[]): Promise<void> {
  await attachRequestedRunSources(runIds, false);
}

async function attachRequestedRunSources(runIds: string[], requireAll: boolean): Promise<void> {
  if (!await supportsWorkers()) return;
  const wanted = new Set(runIds);
  const listed = await rawInvoke<{ streamId: string; runId: string; head: number }[]>("runtime_worker_sources");
  if (!Array.isArray(listed)) throw new Error("Invalid worker source list");
  const adapter = workers();
  const cursors = adapter.captureCursors();
  const found = new Set<string>();
  for (const source of listed) {
    if (wanted.has(source.runId)) {
      found.add(source.runId);
      if (!Object.prototype.hasOwnProperty.call(cursors, source.streamId)) adapter.attachSource(source.streamId);
    }
  }
  if (requireAll && [...wanted].some(id => !found.has(id))) throw new Error("Accepted worker source is not yet available");
  await adapter.reconnect();
}

function retryRunAttachments(): Promise<void> {
  if (attachingRuns) return attachingRuns;
  if (attachmentRetry !== undefined) clearTimeout(attachmentRetry);
  attachmentRetry = undefined;
  const runIds = [...pendingRunAttachments];
  if (!runIds.length) return Promise.resolve();
  attachingRuns = attachRequestedRunSources(runIds, true).then(() => {
    for (const id of runIds) pendingRunAttachments.delete(id);
  }).catch(() => {
    reportWorkerError("accepted-run-attach-failed", "The run was accepted, but its event view could not attach; attachment will retry");
  }).finally(() => {
    attachingRuns = undefined;
    if (pendingRunAttachments.size) {
      attachmentRetry = setTimeout(() => { attachmentRetry = undefined; void retryRunAttachments(); }, 2_000);
      (attachmentRetry as unknown as { unref?: () => void }).unref?.();
    }
  });
  return attachingRuns;
}

async function workerListenersReady(): Promise<void> {
  if (engineListenerReady) await engineListenerReady;
  await workers().start();
}

type WorkerResponse<T> = { handled: boolean; value?: T };
let workerPlanSupport: boolean | undefined;

/** Drop-in for @tauri-apps/api/core invoke, with stable worker mutation identities. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "respond_plan_review") {
    if (workerPlanSupport === false || !await supportsWorkers()) return rawInvoke<T>(cmd, args);
    let result: WorkerResponse<T>;
    try {
      // Native resolves plan/revision to its owning run and hashes Command::Plan.
      // Only that side can distinguish a native worker plan from legacy NextTurn.
      result = await rawInvoke<WorkerResponse<T>>("runtime_worker_plan_review", args);
    } catch (error) {
      if (isMissingWorkerCommand(error, "runtime_worker_plan_review")) {
        workerPlanSupport = false;
        return rawInvoke<T>(cmd, args);
      }
      throw error;
    }
    if (result?.handled === true && result.value !== undefined) return result.value;
    if (result?.handled !== false) throw new Error("Invalid worker plan response");
    return rawInvoke<T>(cmd, args);
  }
  if (cmd === "send_message") {
    const payload = { ...args, runId: args?.runId ?? crypto.randomUUID() };
    if (!await supportsWorkers()) return rawInvoke<T>(cmd, payload);
    await workerListenersReady();
    const { runId, ...startArgs } = payload;
    let result: WorkerResponse<T>;
    try {
      result = await rawInvoke<WorkerResponse<T>>("runtime_worker_start", {
        runId,
        args: { ...startArgs, requireHostChat: true, requireLeader: false },
      });
    } catch (error) {
      if (isMissingWorkerCommand(error, "runtime_worker_start")) return rawInvoke<T>(cmd, payload);
      throw error;
    }
    if (result?.handled === true && result.value !== undefined) {
      const acceptedId = result.value && typeof result.value === "object" && "runId" in result.value && typeof result.value.runId === "string"
        ? result.value.runId : runId;
      if (typeof acceptedId === "string" && acceptedId.length) {
        if (pendingRunAttachments.size < 4096 || pendingRunAttachments.has(acceptedId)) {
          pendingRunAttachments.add(acceptedId);
          // Delivery recovery is separate from start acceptance. Never fall back
          // to send_message or reject an already accepted start on attach failure.
          void retryRunAttachments();
        } else reportWorkerError("accepted-run-limit", "Accepted run attachment queue exceeded its bound");
      }
      return result.value;
    }
    if (result?.handled !== false) throw new Error("Invalid worker start response");
    return rawInvoke<T>(cmd, payload);
  }
  const operations: Record<string, string> = {
    interrupt_session: "interrupt",
    interrupt_turn: "interrupt_turn",
    send_follow_up: "followup",
    stop_native_task: "stop_task",
    answer_question: "answer_question",
  };
  const op = operations[cmd];
  const key = args?.runId ?? args?.sessionId;
  if (op && typeof key === "string" && key.length > 0) {
    if (!await supportsWorkers()) return rawInvoke<T>(cmd, args);
    const command: Record<string, unknown> = { op };
    if (cmd === "send_follow_up") Object.assign(command, { prompt: args?.prompt, image_paths: args?.imagePaths ?? [] });
    if (cmd === "stop_native_task") command.task_id = args?.taskId;
    if (cmd === "answer_question") Object.assign(command, { question_id: args?.requestId, answers: args?.answers ?? null });
    let result: WorkerResponse<T>;
    try {
      result = await rawInvoke<WorkerResponse<T>>("runtime_worker_control", { request: { key, requestId: crypto.randomUUID(), command } });
    } catch (error) {
      if (isMissingWorkerCommand(error, "runtime_worker_control")) return rawInvoke<T>(cmd, args);
      throw error;
    }
    if (result?.handled === true) return result.value as T;
    if (result?.handled !== false) throw new Error("Invalid worker control response");
  }
  return rawInvoke<T>(cmd, args);
}

/** Drop-in for @tauri-apps/api/event listen (same payload-wrapped shape). */
export async function listen<T>(
  name: string,
  cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  const callback: Listener = payload => cb({ payload: payload as T });
  const subscribers = publicListeners.get(name) ?? new Set<Listener>();
  subscribers.add(callback);
  publicListeners.set(name, subscribers);
  let unlisten: UnlistenFn | undefined;
  const ready = (async () => {
    unlisten = await rawListen(name, callback);
    if (name === "engine://event" && workerSupport !== false) {
      try { await workers().start(); }
      catch (error) {
        if (!isMissingWorkerCommand(error, "runtime_worker_sources")) throw error;
      }
    }
  })();
  if (name === "engine://event") engineListenerReady = ready;
  try { await ready; }
  catch (error) {
    unlisten?.(); subscribers.delete(callback);
    if (engineListenerReady === ready) engineListenerReady = undefined;
    if (subscribers.size === 0) publicListeners.delete(name);
    throw error;
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) publicListeners.delete(name);
    // Tauri's UnlistenFn is typed void but returns a promise at runtime.
    // Preserve it so teardown callers can observe failures without an
    // unhandled rejection; local subscriptions are removed even if it throws.
    return unlisten?.();
  };
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  workerEvents?.dispose();
  if (attachmentRetry !== undefined) clearTimeout(attachmentRetry);
  pendingRunAttachments.clear();
  deliveryReceipts.clear();
  receiptCallbacks = 0;
});

/** Version reported by the bridge hello frame; null when unavailable. */
export function serverVersion(): Promise<string | null> {
  if (!isWeb) return Promise.resolve(null);
  return (bridge ??= new WebBridge()).serverVersion();
}
