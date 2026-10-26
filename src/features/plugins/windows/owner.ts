import {
  copyAction, copyJson, defaultDetachedTransport, EVENTS, jsonKey, sameWindow,
  type ActionEvent, type ActionReceipt, type DetachedAction, type DetachedLabels,
  type DetachedSnapshot, type DetachedStatus, type DetachedTransport, type JsonValue,
  type OwnerIdentity, type ReturnedEvent, type ReturnBlockedEvent,
} from "./protocol";
import { assertRuntimeSubmissionAllowed, registerRuntimeCheckpointBlocker } from "@/lib/runtime-checkpoint";
import { registerPluginTabLifecycle } from "../runtime/center-tabs";

export type Presentation = "docked" | "detached";
interface PresentationState { presentation: Presentation; wasOpen: boolean }

export interface DetachedSurfaceOwnerOptions {
  pluginId: string; tabId: string; title: () => string; rendererExport: string;
  assets: { code: string; css: string };
  getSnapshot: () => JsonValue;
  subscribe: (listener: () => void) => () => void;
  dispatch: (action: DetachedAction) => JsonValue | void | Promise<JsonValue | void>;
  onReturn: (reason: "return" | "closed") => void;
  assertCanOpen?: () => void;
  labels: DetachedLabels; dark?: () => boolean; transport?: DetachedTransport;
  defaultPresentation?: Presentation;
}

class ReturnBlockedError extends Error {}
export interface DetachedSurfaceOwner {
  readonly checkpointParticipant: string;
  open(): Promise<void>; returnToMain(reason?: "return" | "maintenance", options?: { force?: boolean }): Promise<void>; dispose(): void;
  present(): Promise<Presentation>;
  restore(): Promise<Presentation | null>;
  flushPresentation(): Promise<void>;
  cancelRestore?(): void;
  getStatus(): DetachedStatus; subscribeStatus(listener: () => void): () => void;
}

export function createDetachedSurfaceOwner(options: DetachedSurfaceOwnerOptions): DetachedSurfaceOwner {
  const transport = options.transport ?? defaultDetachedTransport;
  const registrationId = crypto.randomUUID();
  const ownerToken = crypto.randomUUID();
  let intent: PresentationState = { presentation: options.defaultPresentation ?? "docked", wasOpen: false };
  let registration: Promise<void> | undefined;
  let persistence = Promise.resolve();
  let pendingIntent: { value: PresentationState | boolean } | undefined;
  let intentRevision = 0;
  let disposed = false;
  let identity: OwnerIdentity | undefined;
  let status: DetachedStatus = { phase: "docked" };
  let snapshot: DetachedSnapshot = { revision: 0, state: copyJson(options.getSnapshot()) };
  let serializedState = jsonKey(snapshot.state);
  const statusListeners = new Set<() => void>();
  const unlisteners: (() => void)[] = [];
  let listenFailed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let openPromise: Promise<void> | undefined;
  let openingFocus = true;
  let returnPromise: Promise<void> | undefined;
  let returnWaiter: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let publication = Promise.resolve();
  const retirementSignal = () => {
    let retire!: () => void;
    const promise = new Promise<void>(resolve => { retire = resolve; });
    return { promise, retire };
  };
  let publicationEpoch = 0;
  let publicationRetirement = retirementSignal();
  let publicationQueued = false;
  let publicationNeeded = false;
  let published: { target: OwnerIdentity; revision: number; dark: boolean } | undefined;
  function retirePublication() {
    publicationRetirement.retire(); publicationRetirement = retirementSignal(); publicationEpoch++;
    publication = Promise.resolve(); publicationQueued = false; publicationNeeded = false; published = undefined;
  }
  let execution = Promise.resolve();
  let nextSequence = 1;
  const receipts = new Map<number, { action: string; receipt?: Promise<ActionReceipt> }>();
  const confirmations = new Map<number, { event: Pick<ActionEvent, "windowId" | "registrationId" | "sequence">; result: Omit<ActionReceipt, "snapshot">; bytes: number; sending: boolean }>();
  let confirmationBytes = 0;
  function clearConfirmations() { confirmations.clear(); confirmationBytes = 0; }
  const earlyReturns: ReturnedEvent[] = [];
  function setStatus(next: DetachedStatus) { status = next; for (const listener of statusListeners) listener(); }
  function fail(message: string) { if (!disposed) setStatus({ phase: "error", error: message, windowId: identity?.windowId }); }
  function openRequest(focus = true) {
    return { pluginId: options.pluginId, tabId: options.tabId, registrationId, ownerToken,
      title: options.title(), rendererExport: options.rendererExport, code: options.assets.code, css: options.assets.css,
      snapshot, dark: options.dark?.() ?? false, labels: options.labels, focus };
  }
  function ensureRegistered(): Promise<void> {
    if (registration) return registration;
    const work = (async () => {
      await ready;
      if (disposed) throw new Error("Owner disposed");
      const saved = await transport.invoke<PresentationState | null>("plugin_window_presentation_register", { request: openRequest(false) });
      if (disposed) {
        await transport.invoke("plugin_window_dispose", { request: { registrationId, ownerToken } });
        throw new Error("Owner disposed");
      }
      if (saved) intent = saved;
    })();
    registration = work;
    void work.catch(() => { if (registration === work) registration = undefined; });
    return work;
  }
  function mark(value: PresentationState | boolean, opening = false): Promise<void> {
    const pending = { value }; pendingIntent = pending;
    const work = persistence.catch(() => {}).then(async () => {
      await ensureRegistered();
      if (disposed) throw new Error("Owner disposed");
      if (opening) assertOpenAllowed();
      const next = typeof value === "boolean" ? { ...intent, wasOpen: value } : value;
      await transport.invoke("plugin_window_presentation_set", { request: { pluginId: options.pluginId, tabId: options.tabId, registrationId, ownerToken, ...next } });
      intent = next;
      if (pendingIntent === pending) pendingIntent = undefined;
    });
    persistence = work;
    return work;
  }
  async function flushPresentation(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = persistence;
      try { await observed; } catch (error) { if (observed === persistence) throw error; }
    } while (observed !== persistence);
  }
  async function retryPresentation(): Promise<void> {
    try { await flushPresentation(); }
    catch (error) { if (!pendingIntent) throw error; await mark(pendingIntent.value); }
  }
  function assertOpenAllowed() {
    if (disposed) throw new Error("Owner disposed");
    assertRuntimeSubmissionAllowed(); options.assertCanOpen?.();
  }
  const unregisterTabLifecycle = registerPluginTabLifecycle(options.tabId, event => {
    if (disposed || event.reason !== "user" || identity || openPromise || returnPromise) return;
    intentRevision++;
    void mark(event.type === "open").catch(() => fail("Unable to save plugin view presentation"));
  });
  async function present(): Promise<Presentation> {
    intentRevision++;
    assertOpenAllowed();
    await ensureRegistered(); await retryPresentation();
    assertOpenAllowed();
    if (identity || intent.presentation === "detached") { await open(); assertOpenAllowed(); return "detached"; }
    await mark({ presentation: "docked", wasOpen: true }, true);
    assertOpenAllowed();
    setStatus({ phase: "docked" });
    return "docked";
  }
  async function restore(): Promise<Presentation | null> {
    const revision = intentRevision;
    try {
      await ensureRegistered(); await flushPresentation();
      if (disposed || revision !== intentRevision) return null;
      if (!identity && status.phase === "error") setStatus({ phase: "docked" });
      if (!intent.wasOpen) return null;
      assertOpenAllowed();
      if (intent.presentation === "detached") await open(false, () => revision === intentRevision);
      if (disposed || revision !== intentRevision) return null;
      assertOpenAllowed();
      return intent.presentation;
    } catch (error) { if (revision === intentRevision) fail("Unable to restore plugin view presentation"); throw error; }
  }
  function refreshSnapshot() {
    const state = copyJson(options.getSnapshot());
    const serialized = jsonKey(state);
    if (serialized !== serializedState) {
      if (snapshot.revision === Number.MAX_SAFE_INTEGER) throw new Error("Snapshot revision exhausted");
      snapshot = { revision: snapshot.revision + 1, state }; serializedState = serialized;
    }
    return snapshot;
  }
  async function publishSnapshot(target: OwnerIdentity, force = false) {
    if (disposed || identity !== target) return;
    const current = refreshSnapshot();
    const dark = options.dark?.() ?? false;
    if (!force && published?.target === target && published.revision === current.revision && published.dark === dark) return;
    await transport.invoke("plugin_window_publish", { request: { ...target, snapshot: current, dark } });
    if (!disposed && identity === target) published = { target, revision: current.revision, dark };
  }
  function schedulePublication() {
    if (disposed || !identity || publicationQueued) return;
    const target = identity;
    const epoch = publicationEpoch;
    publicationQueued = true;
    // Only the next replaceable display snapshot is pending. Read the latest
    // state when transport is ready, rather than retaining one full copy per
    // notification. Action execution and its durable receipts stay separate.
    publication = publication.catch(() => {}).then(async () => {
      if (disposed || identity !== target) return;
      publicationNeeded = false;
      await publishSnapshot(target);
    }).catch(() => {
      if (!disposed && publicationEpoch === epoch && identity === target) fail("Unable to publish detached state");
    }).finally(() => {
      if (publicationEpoch !== epoch) return;
      publicationQueued = false;
      if (publicationNeeded) schedulePublication();
    });
  }
  const unsubscribe = options.subscribe(() => {
    if (disposed) return;
    publicationNeeded = true;
    // Docked views read the controller directly. Opening captures the current
    // state explicitly, so hidden/docked changes need no JSON work here.
    schedulePublication();
  });
  function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; }
  async function respond(event: Pick<ActionEvent, "windowId" | "registrationId" | "sequence">, receipt: ActionReceipt, report = true): Promise<"accepted" | "expired" | "retry"> {
    if (disposed || !sameWindow(identity, event)) return "retry";
    try { await transport.invoke("plugin_window_respond", { request: { ...identity, ...receipt, value: receipt.value ?? null } }); return "accepted"; }
    catch (error) {
      if (disposed || !sameWindow(identity, event)) return "retry";
      const reason = typeof error === "string" && /^plugin_window_[a-z_]+$/.test(error) ? error : "transport_error";
      if (report) console.warn("[plugins] Detached receipt confirmation failed", { windowId: event.windowId, sequence: event.sequence, reason });
      if (reason === "plugin_window_action_not_pending_or_expired") { fail("Detached action result is no longer retained"); return "expired"; }
      fail("Unable to confirm detached action result");
      return "retry";
    }
  }
  async function confirm(sequence: number, report = false) {
    const pending = confirmations.get(sequence);
    if (!pending || pending.sending || disposed || !sameWindow(identity, pending.event)) return;
    pending.sending = true;
    // Only resend an already computed result. The action callback is never run
    // again, and snapshots are shared/current rather than retained per attempt.
    const outcome = await respond(pending.event, { ...pending.result, snapshot }, report);
    pending.sending = false;
    if (outcome !== "retry" && confirmations.get(sequence) === pending) {
      confirmations.delete(sequence); confirmationBytes -= pending.bytes;
      if (outcome === "accepted" && !confirmations.size && !returnPromise && status.error === "Unable to confirm detached action result") setStatus({ phase: "detached", windowId: identity?.windowId });
    }
  }
  async function receiveAction(event: ActionEvent) {
    if (disposed || event.registrationId !== registrationId || event.ownerToken !== ownerToken) return;
    if (!identity && openPromise) await openPromise.catch(() => {});
    if (disposed || !sameWindow(identity, event)) return;
    let action: DetachedAction;
    try { action = copyAction(event.action); }
    catch { await respond(event, { sequence: event.sequence, ok: false, error: "Invalid detached action", snapshot }); return; }
    const actionKey = jsonKey(action as unknown as JsonValue);
    const existing = receipts.get(event.sequence);
    if (existing) {
      if (existing.action !== actionKey) return;
      await existing.receipt; // The original callback alone sends the response.
      return;
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== nextSequence) {
      await respond(event, { sequence: event.sequence, ok: false, error: "Invalid or expired action sequence", snapshot }); return;
    }
    nextSequence++;
    const target = identity;
    const receipt = execution.then(async (): Promise<ActionReceipt> => {
      if (disposed || identity !== target) return { sequence: event.sequence, ok: false, error: "Owner unavailable", snapshot };
      try {
        assertRuntimeSubmissionAllowed();
        const value = await options.dispatch(action);
        refreshSnapshot();
        return { sequence: event.sequence, ok: true, value: copyJson(value === undefined ? null : value), snapshot };
      } catch {
        try { refreshSnapshot(); } catch { /* Keep the last valid snapshot. */ }
        return { sequence: event.sequence, ok: false, error: "Detached action failed", snapshot };
      }
    });
    execution = receipt.then(() => {});
    const entry = { action: actionKey, receipt: receipt as Promise<ActionReceipt> | undefined };
    receipts.set(event.sequence, entry);
    const result = await receipt;
    if (disposed || identity !== target || !sameWindow(identity, event)) { entry.receipt = undefined; return; }
    const { snapshot: _snapshot, ...confirmedResult } = result;
    const bytes = new TextEncoder().encode(JSON.stringify(confirmedResult)).length;
    if (confirmations.size < 64 && confirmationBytes + bytes <= 16 * 1024 * 1024) {
      confirmations.set(event.sequence, { event: { windowId: event.windowId, registrationId: event.registrationId, sequence: event.sequence }, result: confirmedResult, bytes, sending: false });
      confirmationBytes += bytes;
      await confirm(event.sequence, true);
    } else {
      // A full recovery buffer cannot justify replay or unbounded retention.
      await respond(event, result);
    }
    // Native owns completed receipts. Retain only the small dedup key, not a snapshot per action.
    entry.receipt = undefined;
    if (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
  }
  function receiveReturned(event: ReturnedEvent) {
    if (disposed || event.ownerToken !== ownerToken || event.registrationId !== registrationId || event.tabId !== options.tabId) return;
    if (!identity && openPromise) { if (earlyReturns.length < 128) earlyReturns.push(event); return; }
    if (!sameWindow(identity, event)) return;
    identity = undefined; retirePublication(); openPromise = undefined; stopHeartbeat(); receipts.clear(); clearConfirmations(); nextSequence = 1;
    setStatus({ phase: "docked" });
    if (returnWaiter) { clearTimeout(returnWaiter.timer); returnWaiter.resolve(); returnWaiter = undefined; }
    if (event.reason === "return") intent = { presentation: "docked", wasOpen: true };
    else if (event.reason === "closed") intent = { presentation: "detached", wasOpen: false };
    if (event.reason !== "maintenance") { intentRevision++; options.onReturn(event.reason); }
  }
  const ready = Promise.all([
    transport.listen<ActionEvent>(EVENTS.action, ({ payload }) => { void receiveAction(payload).catch(() => fail("Detached action failed")); }),
    transport.listen<ReturnedEvent>(EVENTS.returned, ({ payload }) => receiveReturned(payload)),
    transport.listen<ReturnBlockedEvent>(EVENTS.returnBlocked, ({ payload }) => {
      if (disposed || payload.ownerToken !== ownerToken || payload.tabId !== options.tabId || !sameWindow(identity, payload)) return;
      if (returnWaiter) { clearTimeout(returnWaiter.timer); returnWaiter.reject(new ReturnBlockedError("Unconfirmed edits remain in detached window")); returnWaiter = undefined; }
      setStatus({ phase: "detached", windowId: identity?.windowId, error: "Unconfirmed edits remain in detached window", returnBlocked: true });
    }),
  ].map(promise => promise.then(unlisten => { if (disposed || listenFailed) unlisten(); else unlisteners.push(unlisten); }))).then(() => {});
  void ready.catch(() => {
    listenFailed = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
    fail("Unable to subscribe to detached window events");
  });

  function open(focus = true, stillCurrent?: () => boolean): Promise<void> {
    if (disposed) return Promise.reject(new Error("Owner disposed"));
    try { assertRuntimeSubmissionAllowed(); options.assertCanOpen?.(); } catch (error) { return Promise.reject(error); }
    if (openPromise) return focus && !openingFocus ? openPromise.then(() => open()) : openPromise;
    if (returnPromise) return Promise.reject(new Error("Window is returning"));
    openingFocus = focus;
    const epoch = publicationEpoch;
    setStatus({ phase: "opening", windowId: identity?.windowId });
    const opening = (async () => {
      await ready;
      await ensureRegistered();
      if (focus) await retryPresentation(); else await flushPresentation();
      if (stillCurrent && !stillCurrent()) return;
      assertOpenAllowed();
      refreshSnapshot();
      const opened = await transport.invoke<{ windowId: string; label: string; registrationId: string }>("plugin_window_open", {
        request: openRequest(focus),
      });
      if (disposed) {
        await transport.invoke("plugin_window_dispose", { request: { registrationId, ownerToken } });
        return;
      }
      if (opened.registrationId !== registrationId) throw new Error("Detached registration mismatch");
      intent = { presentation: "detached", wasOpen: true };
      if (identity?.windowId !== opened.windowId) { receipts.clear(); clearConfirmations(); nextSequence = 1; }
      if (identity?.windowId !== opened.windowId) identity = { windowId: opened.windowId, registrationId, ownerToken };
      for (const event of earlyReturns.splice(0)) if (sameWindow(identity, event)) receiveReturned(event);
      if (!identity) return;
      // Catch changes between the open request snapshot and native window creation.
      const target = identity;
      const retired = publicationRetirement.promise;
      publication = publication.catch(() => {}).then(async () => {
        if (!disposed && identity === target) {
          publicationNeeded = false;
          await publishSnapshot(target, true);
        }
      });
      await Promise.race([publication, retired]);
      if (disposed || identity !== target) return;
      assertOpenAllowed();
      setStatus({ phase: "detached", windowId: identity.windowId });
      stopHeartbeat();
      heartbeat = setInterval(() => {
        if (!identity || disposed) return;
        const target = identity;
        for (const sequence of confirmations.keys()) void confirm(sequence).catch(() => fail("Unable to confirm detached action result"));
        void transport.invoke("plugin_window_owner_alive", { request: { registrationId, ownerToken } }).catch(() => {
          if (!disposed && identity === target) setStatus({ phase: "unavailable", windowId: target.windowId, error: "Detached owner unavailable" });
        });
      }, 3000);
    })().catch(error => { if (publicationEpoch === epoch) fail("Unable to open detached window"); throw error; }).finally(() => { if (openPromise === opening) openPromise = undefined; });
    openPromise = opening;
    return opening;
  }
  function returnToMain(reason: "return" | "maintenance" = "return", returnOptions?: { force?: boolean }): Promise<void> {
    intentRevision++;
    if (disposed) return Promise.reject(new Error("Owner disposed"));
    if (returnOptions?.force && reason === "maintenance") return Promise.reject(new Error("Maintenance return cannot force discard"));
    if (returnPromise) return returnPromise;
    returnPromise = (async () => {
      await openPromise;
      if (!identity) { if (reason === "return") await mark({ presentation: "docked", wasOpen: true }); return; }
      const target = identity;
      setStatus({ phase: "returning", windowId: target.windowId });
      if (returnOptions?.force) {
        try {
          await transport.invoke("plugin_window_return", { request: { ...target, reason: "return", force: true } });
          receiveReturned({ ...target, tabId: options.tabId, reason: "return" });
        } catch (error) {
          fail("Unable to return detached window; pending actions may be unconfirmed");
          throw error;
        }
        return;
      }
      const returned = new Promise<void>((resolve, reject) => {
        returnWaiter = { resolve, reject, timer: setTimeout(() => { returnWaiter = undefined; reject(new Error("Detached return timed out")); }, 30_000) };
      });
      // Attach a handler before invoking, since native failure can precede the timeout.
      void returned.catch(() => {});
      try {
        await transport.invoke("plugin_window_request_return", { request: { ...target, ...(reason === "maintenance" ? { reason } : {}) } });
        await returned;
      } catch (error) {
        if (returnWaiter) { clearTimeout(returnWaiter.timer); returnWaiter.reject(new Error("Detached return failed")); returnWaiter = undefined; }
        if (!(error instanceof ReturnBlockedError)) fail("Unable to return detached window; pending actions may be unconfirmed");
        throw error;
      }
    })().finally(() => { returnPromise = undefined; });
    return returnPromise;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; identity = undefined; retirePublication(); unsubscribe(); stopHeartbeat(); unregisterRuntimeBlocker(); unregisterTabLifecycle();
    for (const unlisten of unlisteners.splice(0)) unlisten();
    statusListeners.clear(); receipts.clear(); clearConfirmations(); earlyReturns.length = 0;
    if (returnWaiter) { clearTimeout(returnWaiter.timer); returnWaiter.reject(new Error("Owner disposed")); returnWaiter = undefined; }
    void transport.invoke("plugin_window_dispose", { request: { registrationId, ownerToken } }).catch(() => {});
  }
  // Native removal precedes the returned event. Keep the main-document fence
  // until that event reopens its tab, even when the user closed the tab while
  // the floating view was active. This blocker has no checkpoint payload.
  const unregisterRuntimeBlocker = registerRuntimeCheckpointBlocker(`plugin-window-owner:${registrationId}`, () =>
    !disposed && (identity || openPromise || returnPromise) ? ["plugin-window-without-checkpoint"] : []);
  return { checkpointParticipant: `plugin-window-owner:${registrationId}`, open, present, restore, flushPresentation, cancelRestore: () => { intentRevision++; }, returnToMain, dispose, getStatus: () => status, subscribeStatus(listener) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; } };
}
