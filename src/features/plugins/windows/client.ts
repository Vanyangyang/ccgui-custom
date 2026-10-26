import {
  copyAction, copyJson, copySnapshot, defaultDetachedTransport, EVENTS, mergeSnapshot, sameWindow,
  type ActionInspection, type ActionReceipt, type CloseRequestedEvent, type DetachedAction, type DetachedInit,
  type DetachedSnapshot, type DetachedStatus, type DetachedTransport, type JsonValue, type SnapshotEvent,
} from "./protocol";

export interface DetachedActionResult { value: JsonValue; snapshot: DetachedSnapshot; sequence: number }
class ActionRejectedError extends Error {}
class ReturnBlockedError extends Error {}
export interface DetachedSurfaceClient {
  registerReturnGuard(guard: () => boolean): () => void;
  init(): Promise<DetachedInit>;
  getSnapshot(): DetachedSnapshot | undefined;
  getStatus(): DetachedStatus;
  getDark(): boolean;
  subscribe(listener: () => void): () => void;
  dispatch(action: DetachedAction): Promise<DetachedActionResult>;
  requestReturn(reason?: "return" | "closed" | "maintenance"): Promise<void>;
  discardAndReturn(reason?: "return" | "closed"): Promise<void>;
  flush(): Promise<void>;
  reconcile(): Promise<boolean>;
  focusOwner(): Promise<void>;
  status(): Promise<{ ownerAvailable: boolean; closing: boolean }>;
  dispose(): void;
}

export function createDetachedSurfaceClient(options: { transport?: DetachedTransport; messages?: { pending: string; notSent: string } } = {}): DetachedSurfaceClient {
  const transport = options.transport ?? defaultDetachedTransport;
  let disposed = false;
  let initialized: DetachedInit | undefined;
  let initPromise: Promise<DetachedInit> | undefined;
  let snapshot: DetachedSnapshot | undefined;
  let dark = false;
  let currentStatus: DetachedStatus = { phase: "opening" };
  let nextSequence = 1;
  let queue: Promise<void> = Promise.resolve();
  let queueError: Error | undefined;
  let recoveryEpoch = 0;
  let recoveryPromise: Promise<boolean> | undefined;
  const unresolved = new Map<number, { resolve?: (value: DetachedActionResult) => void; reject?: (error: Error) => void }>();
  const pendingMessage = () => options.messages?.pending ?? "Original action result is pending; it will not be resubmitted";
  let returning = false;
  let returnPromise: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let initFailed = false;
  const listeners = new Set<() => void>();
  const returnGuards = new Set<() => boolean>();
  const unlisteners: (() => void)[] = [];
  // Native events may arrive after listen is installed but before init resolves.
  const earlySnapshots: SnapshotEvent[] = [];
  const earlyCloses: CloseRequestedEvent[] = [];
  function notify() { for (const listener of listeners) listener(); }
  function setStatus(status: DetachedStatus) { currentStatus = status; notify(); }
  function fail(message: string, unavailable = false) {
    if (disposed) return;
    if (unavailable && currentStatus.phase !== "unavailable") recoveryEpoch++;
    setStatus({ phase: unavailable ? "unavailable" : "error", error: message, windowId: initialized?.windowId });
  }
  function acceptSnapshot(incoming: DetachedSnapshot, incomingDark?: boolean) {
    const previous = snapshot;
    snapshot = mergeSnapshot(snapshot, incoming);
    if (incomingDark !== undefined && (!previous || incoming.revision >= previous.revision)) dark = incomingDark;
    if (snapshot !== previous || incomingDark !== undefined) notify();
  }
  function receiveSnapshot(event: SnapshotEvent) {
    if (disposed) return;
    if (!initialized) {
      try {
        const index = earlySnapshots.findIndex(previous => sameWindow(previous, event));
        const previous = earlySnapshots[index];
        const merged = mergeSnapshot(previous?.snapshot, event.snapshot);
        if (index >= 0) {
          if (event.snapshot.revision >= previous.snapshot.revision) earlySnapshots[index] = { ...event, snapshot: merged };
        } else {
          if (earlySnapshots.length >= 4) throw new Error("Too many startup window identities");
          earlySnapshots.push({ ...event, snapshot: merged });
        }
      } catch { queueError = new Error("Invalid detached startup snapshot"); fail(queueError.message); }
      return;
    }
    if (!sameWindow(initialized, event)) return;
    try { acceptSnapshot(event.snapshot, event.dark); }
    catch { queueError = new Error("Invalid detached snapshot"); fail(queueError.message); }
  }
  function receiveClose(event: CloseRequestedEvent) {
    if (disposed) return;
    if (!initialized) { if (earlyCloses.length < 128) earlyCloses.push(event); return; }
    if (!sameWindow(initialized, event)) return;
    void requestReturn(event.reason ?? "closed").catch(() => {});
  }
  async function status() {
    if (disposed || !initialized) throw new Error("Detached client unavailable");
    try {
      const result = await transport.invoke<{ ownerAvailable: boolean; closing: boolean; reason?: "return" | "closed" | "maintenance" }>("plugin_window_status");
      if (disposed) throw new Error("Detached client disposed");
      if (!result.ownerAvailable) {
        fail("Detached owner unavailable; pending action outcome may be unknown", true);
      } else if (result.closing && !returning) {
        void requestReturn(result.reason ?? "closed").catch(() => {});
      }
      return result;
    } catch {
      fail("Detached owner unavailable; pending action outcome may be unknown", true);
      throw new Error("Detached owner unavailable");
    }
  }
  function init(): Promise<DetachedInit> {
    if (disposed) return Promise.reject(new Error("Detached client disposed"));
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await Promise.all([
        transport.listen<SnapshotEvent>(EVENTS.snapshot, ({ payload }) => receiveSnapshot(payload)),
        transport.listen<CloseRequestedEvent>(EVENTS.closeRequested, ({ payload }) => receiveClose(payload)),
      ].map(promise => promise.then(unlisten => { if (disposed || initFailed) unlisten(); else unlisteners.push(unlisten); })));
      if (disposed) throw new Error("Detached client disposed");
      const data = await transport.invoke<DetachedInit>("plugin_window_init");
      if (disposed) throw new Error("Detached client disposed");
      initialized = data;
      if (!Number.isSafeInteger(data.nextSequence) || data.nextSequence < 1) throw new Error("Invalid detached sequence watermark");
      nextSequence = data.nextSequence;
      if (!Array.isArray(data.unresolvedSequences) || data.unresolvedSequences.length > 192 || new Set(data.unresolvedSequences).size !== data.unresolvedSequences.length ||
        data.unresolvedSequences.some(sequence => !Number.isSafeInteger(sequence) || sequence < 1 || sequence >= nextSequence)) throw new Error("Invalid unresolved detached sequences");
      for (const sequence of data.unresolvedSequences) unresolved.set(sequence, {});
      acceptSnapshot(data.snapshot, data.dark);
      for (const event of earlySnapshots.splice(0)) receiveSnapshot(event);
      if (queueError) throw queueError;
      setStatus({ phase: unresolved.size ? "recovering" : "detached", windowId: data.windowId, ...(unresolved.size ? { error: pendingMessage() } : {}) });
      pollTimer = setInterval(() => {
        if (polling || disposed) return;
        polling = true;
        void (unresolved.size || currentStatus.phase === "unavailable" ? reconcile() : status()).catch(() => {}).finally(() => { polling = false; });
      }, 5000);
      for (const event of earlyCloses.splice(0)) receiveClose(event);
      return { ...data, snapshot: snapshot!, dark };
    })().catch(error => {
      initFailed = true;
      queueError ??= new Error("Detached initialization failed");
      for (const unlisten of unlisteners.splice(0)) unlisten();
      fail("Unable to initialize detached window"); throw error;
    });
    return initPromise;
  }
  function acceptReceipt(receipt: ActionReceipt, sequence: number): DetachedActionResult {
    if (!receipt || receipt.sequence !== sequence || typeof receipt.ok !== "boolean" ||
      (receipt.unknown !== undefined && typeof receipt.unknown !== "boolean") ||
      (receipt.error != null && typeof receipt.error !== "string")) throw new Error("Invalid detached action receipt");
    const receiptSnapshot = copySnapshot(receipt.snapshot);
    const value = copyJson(receipt.value === undefined ? null : receipt.value);
    acceptSnapshot(receiptSnapshot);
    if (receipt.unknown) throw new Error(pendingMessage());
    if (!receipt.ok) throw new ActionRejectedError(receipt.error || "Detached action failed");
    return { value, snapshot: snapshot!, sequence };
  }
  function awaitOriginalReceipt(sequence: number): Promise<DetachedActionResult> {
    recoveryEpoch++;
    const result = new Promise<DetachedActionResult>((resolve, reject) => { unresolved.set(sequence, { resolve, reject }); });
    setStatus({ phase: "recovering", error: pendingMessage(), windowId: initialized?.windowId });
    return result;
  }
  function reconcile(): Promise<boolean> {
    if (disposed || !initialized) return Promise.resolve(false);
    if (recoveryPromise) return recoveryPromise;
    const target = initialized;
    recoveryPromise = (async () => {
      for (const [sequence, pending] of [...unresolved]) {
        try {
          const result = await transport.invoke<ActionInspection>("plugin_window_inspect_action", { request: { windowId: target.windowId, registrationId: target.registrationId, sequence } });
          if (disposed || initialized !== target) return false;
          if (!result || !sameWindow(target, result) || result.sequence !== sequence || result.state !== "resolved") continue;
          let value: DetachedActionResult;
          try { value = acceptReceipt(result.receipt!, sequence); }
          catch (error) {
            if (!(error instanceof ActionRejectedError)) continue;
            unresolved.delete(sequence); pending.reject?.(error); continue;
          }
          unresolved.delete(sequence); pending.resolve?.(value);
        } catch { /* Preserve the exact unresolved sequence; never resubmit it. */ }
      }
      if (disposed || initialized !== target) return false;
      let available = false;
      try { available = (await status()).ownerAvailable; } catch { /* The original owner remains unavailable. */ }
      if (disposed || initialized !== target) return false;
      if (available && !unresolved.size && !queueError) {
        setStatus({ phase: returning ? "returning" : "detached", windowId: target.windowId });
        return true;
      }
      if (available && unresolved.size) setStatus({ phase: "recovering", error: pendingMessage(), windowId: target.windowId });
      return false;
    })().finally(() => { recoveryPromise = undefined; });
    return recoveryPromise;
  }
  async function focusOwner() {
    if (disposed || !initialized) throw new Error("Detached client unavailable");
    await transport.invoke("plugin_window_focus_owner", { request: { windowId: initialized.windowId, registrationId: initialized.registrationId } });
  }
  function dispatch(input: DetachedAction): Promise<DetachedActionResult> {
    if (disposed || !initialized || returning || currentStatus.phase !== "detached")
      return Promise.reject(new Error("Detached window is not accepting actions"));
    let action: DetachedAction;
    try { action = copyAction(input); } catch (error) { return Promise.reject(error); }
    const epoch = recoveryEpoch;
    const target = initialized;
    const operation = queue.then(async () => {
      if (disposed || queueError) throw queueError ?? new Error("Detached client disposed");
      if (epoch !== recoveryEpoch) throw new ActionRejectedError(options.messages?.notSent ?? "This queued action was not sent; review it before submitting again");
      if (!Number.isSafeInteger(nextSequence) || nextSequence >= Number.MAX_SAFE_INTEGER) throw new Error("Detached action sequence exhausted");
      const sequence = nextSequence++;
      try {
        const receipt = await transport.invoke<ActionReceipt>("plugin_window_action", {
          request: { windowId: target.windowId, registrationId: target.registrationId, sequence, action },
        });
        if (disposed) throw new Error("Detached client disposed");
        const result = acceptReceipt(receipt, sequence);
        if (!disposed && !returning && currentStatus.phase === "detached" && currentStatus.returnBlocked) {
          const canReturn = [...returnGuards].every(guard => { try { return guard(); } catch { return false; } });
          if (canReturn) setStatus({ phase: "detached", windowId: target.windowId });
        }
        return result;
      } catch (error) {
        if (disposed || error instanceof ActionRejectedError) throw error;
        // These exact native errors occur before admission and do not consume
        // a sequence. A transport error, including an Error with similar text,
        // supplies no such proof and must keep the original outcome pending.
        if (typeof error === "string" && ["plugin_window_owner_unavailable", "plugin_window_too_many_pending_actions", "plugin_window_invalid_action"].includes(error)) {
          nextSequence = sequence;
          recoveryEpoch++;
          const message = options.messages?.notSent ?? "This action was not sent; review it before submitting again";
          if (error === "plugin_window_owner_unavailable") fail(message, true);
          throw new ActionRejectedError(message);
        }
        if (typeof error === "string" && ["plugin_window_action_out_of_order", "plugin_window_receipt_expired_no_retry", "plugin_window_action_payload_conflict"].includes(error)) {
          queueError = new Error("Detached action sequence mismatch; this action was not sent");
          throw queueError;
        }
        return awaitOriginalReceipt(sequence);
      }
    });
    queue = operation.then(() => {}, error => {
      if (error instanceof ActionRejectedError) {
        if (!disposed && !returning && currentStatus.phase === "detached") setStatus({ phase: "detached", windowId: initialized?.windowId, error: error.message });
        return;
      }
      queueError ??= new Error("Detached action failed or its outcome is unknown; pending actions were not retried");
      fail(queueError.message);
    });
    return operation;
  }
  async function flush(): Promise<void> {
    if (unresolved.size) throw new Error(pendingMessage());
    // Keep draining if producers appended while we were waiting. requestReturn locks producers first.
    let observed: Promise<void>;
    do { observed = queue; await observed; } while (observed !== queue);
    if (disposed || queueError) throw queueError ?? new Error("Detached client disposed");
  }
  function requestReturn(reason: "return" | "closed" | "maintenance" = "return"): Promise<void> {
    if (disposed || !initialized) return Promise.reject(new Error("Detached client unavailable"));
    if (unresolved.size) return Promise.reject(new Error(pendingMessage()));
    if (returnPromise) return returnPromise;
    returning = true;
    setStatus({ phase: "returning", windowId: initialized.windowId });
    const target = initialized;
    returnPromise = (async () => {
      await flush();
      // Let renderer promise continuations settle their optimistic edits, then
      // ask their live stores rather than a possibly stale React busy flag.
      await Promise.resolve();
      const canReturn = [...returnGuards].every(guard => { try { return guard(); } catch { return false; } });
      if (!canReturn) {
        await transport.invoke("plugin_window_cancel_return", { request: { windowId: target.windowId, registrationId: target.registrationId } });
        returning = false;
        setStatus({
          phase: "detached",
          windowId: target.windowId,
          error: "Unconfirmed edits remain in this window",
          returnBlocked: true,
          blockedReason: reason === "closed" ? "closed" : "return",
        });
        throw new ReturnBlockedError("Unconfirmed edits remain in this window");
      }
      const available = await status();
      if (!available.ownerAvailable) throw new Error("Detached owner unavailable");
      await transport.invoke("plugin_window_return", { request: { windowId: target.windowId, registrationId: target.registrationId, reason } });
      if (!disposed) { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined; setStatus({ phase: "docked" }); }
    })().catch(error => {
      if (!(error instanceof ReturnBlockedError) && currentStatus.phase !== "unavailable") fail("Unable to return window; pending actions may be unconfirmed");
      throw error;
    }).finally(() => { if (currentStatus.phase !== "docked") { returning = false; returnPromise = undefined; } });
    return returnPromise;
  }
  function discardAndReturn(reason?: "return" | "closed"): Promise<void> {
    if (disposed || !initialized) return Promise.reject(new Error("Detached client unavailable"));
    if (returnPromise) return returnPromise;
    const resolvedReason: "return" | "closed" = reason === "return" || reason === "closed"
      ? reason
      : currentStatus.blockedReason ?? "closed";
    returning = true;
    recoveryEpoch++;
    setStatus({ phase: "returning", windowId: initialized.windowId });
    const target = initialized;
    returnPromise = (async () => {
      await transport.invoke("plugin_window_return", {
        request: { windowId: target.windowId, registrationId: target.registrationId, reason: resolvedReason, force: true },
      });
      if (!disposed) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        for (const pending of unresolved.values()) {
          pending.reject?.(new Error("Detached window closed without replaying pending actions"));
        }
        unresolved.clear();
        setStatus({ phase: "docked" });
      }
    })().catch(error => {
      if (currentStatus.phase !== "unavailable") fail("Unable to return window; pending actions may be unconfirmed");
      throw error;
    }).finally(() => { if (currentStatus.phase !== "docked") { returning = false; returnPromise = undefined; } });
    return returnPromise;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; if (pollTimer) clearInterval(pollTimer); pollTimer = undefined;
    for (const pending of unresolved.values()) pending.reject?.(new Error("Detached client disposed; original action was not replayed"));
    unresolved.clear();
    for (const unlisten of unlisteners.splice(0)) unlisten();
    listeners.clear(); returnGuards.clear(); earlyCloses.length = 0; earlySnapshots.length = 0;
  }
  return { init, dispatch, requestReturn, discardAndReturn, flush, status, reconcile, focusOwner, dispose,
    registerReturnGuard(guard) { returnGuards.add(guard); return () => { returnGuards.delete(guard); }; },
    getSnapshot: () => snapshot, getStatus: () => currentStatus, getDark: () => dark,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
