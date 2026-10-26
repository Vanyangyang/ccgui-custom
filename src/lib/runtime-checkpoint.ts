/** Process-local handoff coordination. Native code owns admission/stream cursors;
 * this module owns the synchronous JS snapshot and submission barrier. */
export interface RuntimeCheckpoint {
  version: 1;
  participants: Record<string, unknown>;
}

export interface RuntimeCheckpointParticipant {
  id: string;
  capture(): unknown;
  /** Must restore synchronously, before the importing module exposes its store. */
  restore(value: unknown): void;
  readiness?(): readonly string[];
  /** State that cannot be captured; new UI after restore must not block health. */
  captureReadiness?(): readonly string[];
  ready?(): Promise<void>;
  resumed?(): void;
}

export interface RuntimeCheckpointBlocker { participant: string; reason: string }

/** Reject unsupported values instead of silently losing Maps, cycles or NaN. */
export function cloneCheckpointValue<T>(value: T): T {
  const seen = new Set<object>();
  const check = (item: unknown): void => {
    if (item === null || item === undefined || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") throw new Error("Runtime checkpoint contains a non-JSON value");
    if (seen.has(item)) throw new Error("Runtime checkpoint contains a cycle");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Runtime checkpoint contains a non-plain object");
    }
    seen.add(item);
    for (const child of Object.values(item)) check(child);
    seen.delete(item);
  };
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createRuntimeCheckpointCoordinator() {
  const participants = new Map<string, RuntimeCheckpointParticipant>();
  const pending = new Map<string, unknown>();
  const operations = new Map<symbol, string>();
  const blockers = new Map<string, () => readonly string[]>();
  // A chat snapshot alone does not attest that plugins, terminal or other UI is
  // transferable. The host must register an explicit app-ui coverage participant.
  let required = new Set(["chat", "app-ui"]);
  let paused = false;
  let preparing = false;
  let revision = 0;
  const resumeWaiters = new Set<() => void>();
  const whenResumed = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        resumeWaiters.delete(onResume);
        signal?.removeEventListener("abort", onAbort);
      };
      const onResume = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(signal?.reason); };
      resumeWaiters.add(onResume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const readiness = (capturing = true): RuntimeCheckpointBlocker[] => {
    const result: RuntimeCheckpointBlocker[] = [];
    for (const id of required) if (!participants.has(id)) result.push({ participant: id, reason: "participant-unavailable" });
    for (const id of pending.keys()) if (!participants.has(id)) result.push({ participant: id, reason: "checkpoint-not-restored" });
    for (const [id, participant] of participants) for (const reason of participant.readiness?.() ?? []) result.push({ participant: id, reason });
    if (capturing) for (const [id, participant] of participants) for (const reason of participant.captureReadiness?.() ?? []) result.push({ participant: id, reason });
    for (const [id, read] of blockers) for (const reason of read()) result.push({ participant: id, reason });
    for (const reason of operations.values()) result.push({ participant: "operation", reason });
    return result;
  };
  const assertAllowed = () => { if (paused) throw new Error("Runtime handoff has paused new submissions"); };
  const assertReady = (capturing = true) => {
    const found = readiness(capturing);
    if (found.length) throw new Error(`Runtime checkpoint is blocked: ${found.map((b) => `${b.participant}:${b.reason}`).join(", ")}`);
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    // Ownership is available even if a participant's resumed callback fails.
    for (const waiter of resumeWaiters) waiter();
    const failures: unknown[] = [];
    for (const participant of participants.values()) {
      try { participant.resumed?.(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Runtime participant resume failed");
  };
  const awaitReady = async () => {
    const ticket = revision;
    await Promise.all([...participants.values()].map((p) => p.ready?.()));
    if (ticket !== revision) throw new Error("Runtime checkpoint readiness was superseded");
    assertReady(false);
  };
  return {
    initialize(checkpoint?: RuntimeCheckpoint, options?: { requiredParticipants?: readonly string[] }) {
      if (participants.size || blockers.size || operations.size || preparing) throw new Error("Initialize runtime checkpoint before importing participants");
      pending.clear();
      required = new Set(options?.requiredParticipants ?? ["chat", "app-ui"]);
      if (checkpoint) {
        const copy = cloneCheckpointValue(checkpoint);
        if (copy.version !== 1 || !copy.participants || Array.isArray(copy.participants) || typeof copy.participants !== "object") throw new Error("Unsupported runtime checkpoint");
        for (const id of required) if (!Object.hasOwn(copy.participants, id)) throw new Error(`Missing checkpoint participant: ${id}`);
        for (const [id, value] of Object.entries(copy.participants)) pending.set(id, value);
      }
      paused = !!checkpoint;
      revision++;
    },
    register(participant: RuntimeCheckpointParticipant): () => void {
      if (participants.has(participant.id)) throw new Error(`Duplicate checkpoint participant: ${participant.id}`);
      if (pending.has(participant.id)) {
        participant.restore(cloneCheckpointValue(pending.get(participant.id)));
        pending.delete(participant.id);
      }
      participants.set(participant.id, participant);
      revision++;
      return () => { if (participants.get(participant.id) === participant) { participants.delete(participant.id); revision++; } };
    },
    registerBlocker(id: string, read: () => readonly string[]): () => void {
      if (blockers.has(id)) throw new Error(`Duplicate checkpoint blocker: ${id}`);
      blockers.set(id, read);
      return () => { if (blockers.get(id) === read) blockers.delete(id); };
    },
    readiness,
    /** An observer captures one projection without taking mutation ownership. */
    captureParticipant(id: string): unknown {
      const participant = participants.get(id);
      if (!participant) throw new Error(`Checkpoint participant is unavailable: ${id}`);
      return cloneCheckpointValue(participant.capture());
    },
    isPaused: () => paused,
    whenResumed,
    assertAllowed,
    beginOperation(reason: string): () => void {
      assertAllowed();
      const token = Symbol(reason);
      operations.set(token, reason);
      return () => { operations.delete(token); };
    },
    async prepare(): Promise<RuntimeCheckpoint> {
      if (preparing) throw new Error("Runtime checkpoint preparation is already in progress");
      paused = true;
      preparing = true;
      const ticket = ++revision;
      try {
        assertReady();
        await Promise.all([...participants.values()].map((p) => p.ready?.()));
        if (ticket !== revision || !paused) throw new Error("Runtime checkpoint preparation was aborted");
        assertReady();
        // No awaits between participant captures: a single JS turn is the cut.
        const captured: Record<string, unknown> = Object.create(null);
        for (const [id, participant] of participants) captured[id] = participant.capture();
        return cloneCheckpointValue({ version: 1, participants: captured });
      } finally { preparing = false; }
    },
    abort() { revision++; resume(); },
    awaitReady,
    // Only the caller holding a successful native health commit may use this.
    // Normal activity arriving during that ACK cannot revoke new ownership.
    resumeCommitted: resume,
    async resume() {
      await awaitReady();
      resume();
    },
  };
}

export const runtimeCheckpoint = createRuntimeCheckpointCoordinator();
export const initializeRuntimeCheckpoint = runtimeCheckpoint.initialize;
export const registerRuntimeCheckpointParticipant = runtimeCheckpoint.register;
export const registerRuntimeCheckpointBlocker = runtimeCheckpoint.registerBlocker;
export const getRuntimeCheckpointReadiness = runtimeCheckpoint.readiness;
export const captureRuntimeCheckpointParticipant = runtimeCheckpoint.captureParticipant;
export const prepareRuntimeCheckpoint = runtimeCheckpoint.prepare;
export const abortRuntimeCheckpoint = runtimeCheckpoint.abort;
export const awaitRuntimeCheckpointReady = runtimeCheckpoint.awaitReady;
export const resumeRuntimeCheckpoint = runtimeCheckpoint.resume;
export const resumeCommittedRuntimeCheckpoint = runtimeCheckpoint.resumeCommitted;
export const isRuntimeSubmissionPaused = runtimeCheckpoint.isPaused;
export const whenRuntimeSubmissionResumed = runtimeCheckpoint.whenResumed;
export const assertRuntimeSubmissionAllowed = runtimeCheckpoint.assertAllowed;
export const beginRuntimeOperation = runtimeCheckpoint.beginOperation;

/** Preserve synchronous actions and promise results while tracking their entire
 * lifetime, including work started before the prepare barrier. */
export function guardRuntimeActions<T extends object>(actions: T, names: readonly (keyof T)[]): T {
  for (const name of names) {
    const action = actions[name] as (...args: unknown[]) => unknown;
    const guarded = function (...args: unknown[]) {
      const done = beginRuntimeOperation(`chat:${String(name)}`);
      try {
        const result = action(...args);
        if (result && typeof (result as Promise<unknown>).then === "function") return Promise.resolve(result).finally(done);
        done();
        return result;
      } catch (error) { done(); throw error; }
    };
    // Async actions must keep rejecting a Promise, including at the frozen
    // admission boundary; callers commonly attach .catch() without try/catch.
    (actions as Record<keyof T, unknown>)[name] = action.constructor.name === "AsyncFunction"
      ? async (...args: unknown[]) => guarded(...args) : guarded;
  }
  return actions;
}
