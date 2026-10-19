import { SequencedEventStream, type EventEnvelope, type ReplayBatch } from "./runtime-event-stream";

export type WorkerCursors = Record<string, number>;
export interface WorkerEnvelopeIdentity { streamId: string; seq: number }
export interface WorkerEventDependencies {
  rawInvoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** The injected listener unwraps the native Event and passes its payload. */
  rawListen: (name: string, callback: (payload: unknown) => void) => Promise<() => void>;
  /** Must commit atomically; throwing delivery is retried without advancing its cursor. */
  deliver: (name: string, payload: unknown, identity?: WorkerEnvelopeIdentity) => void;
  onError: (error: WorkerEventTransportError) => void;
}

export interface WorkerEventOptions {
  maxSources?: number;
  maxQueuedEvents?: number;
  maxBufferedBytes?: number;
  replayLimit?: number;
  maxReplayPages?: number;
}

export class WorkerEventTransportError extends Error {
  constructor(readonly code: string, message: string, readonly streamId?: string) {
    super(message);
    this.name = "WorkerEventTransportError";
  }
}

type Source = { stream: SequencedEventStream; target: number };
type Queued = { event: EventEnvelope; bytes: number };
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Per-worker consumption with a serialized replay/checkpoint boundary. Existing
 * archives in a fresh client's first discovery are not attached automatically.
 * Restored checkpoints and sources first discovered after initialization permit
 * replay from zero; a new live sequence 1 also attaches itself. Unknown later
 * frames stay queued with an explicit error until authoritative attachment or
 * discovery establishes that the source started after this client's baseline.
 */
export class WorkerEventTransport {
  private readonly sources = new Map<string, Source>();
  private readonly queues = new Map<string, Queued[]>();
  private readonly unknownReported = new Set<string>();
  private queuedCount = 0;
  private queuedBytes = 0;
  private readonly limits: Required<WorkerEventOptions>;
  private unlisteners: (() => void)[] = [];
  private phase: "new" | "starting" | "running" | "disposed" = "new";
  private paused = false;
  private tail: Promise<void> = Promise.resolve();
  private startPromise?: Promise<void>;
  private flushScheduled = false;
  private initialSources?: Set<string>;
  private restored = false;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private everStarted = false;
  private startGeneration = 0;

  constructor(private readonly deps: WorkerEventDependencies, options: WorkerEventOptions = {}) {
    this.limits = {
      // Match the native checkpoint bound. Consumed sources keep their cursor
      // even after retirement; dropping it could deliver old archive events twice.
      maxSources: options.maxSources ?? 4096,
      maxQueuedEvents: options.maxQueuedEvents ?? 4096,
      // Native worker chunks may contain a complete event approaching 128 MiB.
      maxBufferedBytes: options.maxBufferedBytes ?? 160 * 1024 * 1024,
      replayLimit: options.replayLimit ?? 256,
      maxReplayPages: options.maxReplayPages ?? 1024,
    };
    for (const value of Object.values(this.limits)) {
      if (!nonnegative(value) || value === 0) throw new WorkerEventTransportError("invalid-options", "Limits must be positive safe integers");
    }
  }

  restoreCursors(cursors: WorkerCursors): void {
    if (this.phase !== "new" || this.everStarted) throw new WorkerEventTransportError("already-started", "Restore cursors before starting listeners");
    const entries = Object.entries(cursors);
    if (entries.length > this.limits.maxSources) throw new WorkerEventTransportError("source-limit", "Too many checkpoint sources");
    for (const [id, cursor] of entries) this.validateCursor(id, cursor);
    this.restored = true;
    this.sources.clear();
    for (const [id, cursor] of entries) this.addSource(id, cursor);
  }

  captureCursors(): WorkerCursors {
    return Object.fromEntries([...this.sources].map(([id, source]) => [id, source.stream.cursor]));
  }

  attachSource(streamId: string, cursor = 0): void {
    this.assertAlive();
    this.validateCursor(streamId, cursor);
    const existing = this.sources.get(streamId);
    if (existing) {
      if (cursor !== existing.stream.cursor) throw new WorkerEventTransportError("cursor-conflict", "Cannot replace an attached cursor", streamId);
      return;
    }
    this.addSource(streamId, cursor);
    if (this.phase === "running") void this.reconnect().catch(() => {});
  }

  start(): Promise<void> {
    this.assertAlive();
    if (this.startPromise) return this.startPromise;
    this.everStarted = true;
    const generation = ++this.startGeneration;
    this.phase = "starting";
    this.startPromise = this.enqueue(async () => {
      try {
        await this.listen("runtime://worker-event", payload => this.receive(payload), generation);
        await this.listen("transport://connected", () => {
          if (this.phase === "running") void this.reconnect().catch(() => {});
        }, generation);
        this.assertAlive();
        this.phase = "running";
        await this.synchronize(true);
      } catch (error) {
        if (this.phase !== "disposed" && generation === this.startGeneration) {
          this.clearListeners();
          this.clearReconciliation();
          this.phase = "new";
          this.startPromise = undefined;
        }
        throw error;
      }
    }).finally(() => { if (generation === this.startGeneration) this.scheduleReconciliation(); });
    return this.startPromise;
  }

  reconnect(): Promise<void> {
    return this.enqueue(() => this.synchronize(true));
  }

  /** Resolves only after earlier replay/delivery finishes. Persist chat and cursors together now. */
  pause(): Promise<void> {
    this.clearReconciliation();
    return this.enqueue(async () => {
      // A prior failed fanout may have committed some subscribers. Finish that
      // envelope (or reject) before allowing UI + cursor checkpoint capture.
      await this.synchronize(false);
      this.paused = true;
      this.clearReconciliation();
    }).finally(() => { if (!this.paused) this.scheduleReconciliation(); });
  }

  resume(): Promise<void> {
    return this.enqueue(async () => {
      this.paused = false;
      await this.synchronize(true);
    }).finally(() => this.scheduleReconciliation());
  }

  dispose(): void {
    if (this.phase === "disposed") return;
    this.phase = "disposed";
    this.startGeneration++;
    this.clearReconciliation();
    this.clearListeners();
    this.queues.clear();
    this.unknownReported.clear();
    this.queuedCount = this.queuedBytes = 0;
  }

  private validateCursor(id: string, cursor: number): void {
    if (!validId(id) || !nonnegative(cursor)) throw new WorkerEventTransportError("invalid-cursor", "Invalid worker cursor", id);
  }

  private addSource(id: string, cursor: number): void {
    const ids = new Set([...this.sources.keys(), ...this.queues.keys(), id]);
    if (ids.size > this.limits.maxSources) throw new WorkerEventTransportError("source-limit", "Too many worker sources", id);
    const stream: SequencedEventStream = new SequencedEventStream((name, payload) => {
        this.assertAlive();
        this.deps.deliver(name, payload, { streamId: id, seq: stream.cursor + 1 });
      }, { streamId: id, cursor, maxBufferedEvents: this.limits.maxQueuedEvents, maxBufferedBytes: this.limits.maxBufferedBytes });
    this.sources.set(id, {
      stream,
      target: Math.max(cursor, ...(this.queues.get(id) ?? []).map(item => item.event.seq)),
    });
    this.unknownReported.delete(id);
  }

  private assertAlive(): void {
    if (this.phase === "disposed") throw new WorkerEventTransportError("disposed", "Worker event transport is disposed");
  }

  private clearListeners(): void {
    for (const unlisten of this.unlisteners.splice(0)) {
      try { unlisten(); } catch (error) { this.report(error); }
    }
  }

  private async listen(name: string, callback: (payload: unknown) => void, generation: number): Promise<void> {
    const unlisten = await this.deps.rawListen(name, payload => {
      if (generation === this.startGeneration && this.phase !== "disposed" && this.phase !== "new") callback(payload);
    });
    if (this.phase === "disposed" || generation !== this.startGeneration) {
      unlisten();
      this.assertAlive();
      throw new WorkerEventTransportError("stale-start", "Worker listener startup was superseded");
    }
    this.unlisteners.push(unlisten);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(async () => { this.assertAlive(); await operation(); });
    this.tail = result.catch(error => {
      if (this.phase !== "disposed") this.report(error);
    });
    return result;
  }

  private report(error: unknown): void {
    const normalized = error instanceof WorkerEventTransportError ? error : new WorkerEventTransportError("transport-failed", "Worker event transport operation failed");
    // Reporting cannot break serialization or produce an unhandled rejection.
    try { this.deps.onError(normalized); } catch { /* The original operation still rejects. */ }
  }

  private receive(payload: unknown): void {
    if (this.phase === "disposed") return;
    try {
      const event = payload as EventEnvelope;
      if (!event || !validId(event.stream_id) || !nonnegative(event.seq) || event.seq === 0 || !validId(event.name)) throw new WorkerEventTransportError("invalid-event", "Invalid live worker envelope");
      if (!this.sources.has(event.stream_id) && event.seq === 1) this.addSource(event.stream_id, 0);
      const source = this.sources.get(event.stream_id);
      // Even a dropped final live frame advances the authoritative replay target.
      // Watermark reconciliation also repairs frames lost before reaching JS.
      if (source) source.target = Math.max(source.target, event.seq);
      const ids = new Set([...this.sources.keys(), ...this.queues.keys(), event.stream_id]);
      if (ids.size > this.limits.maxSources) throw new WorkerEventTransportError("source-limit", "Too many unknown worker sources", event.stream_id);
      const serialized = JSON.stringify(event);
      const bytes = new TextEncoder().encode(serialized).byteLength;
      if (this.queuedCount >= this.limits.maxQueuedEvents || this.queuedBytes + bytes > this.limits.maxBufferedBytes) throw new WorkerEventTransportError("queue-limit", "Worker event queue exceeded its bound", event.stream_id);
      const queue = this.queues.get(event.stream_id) ?? [];
      queue.push({ event: JSON.parse(serialized) as EventEnvelope, bytes });
      this.queues.set(event.stream_id, queue);
      this.queuedCount++;
      this.queuedBytes += bytes;
      if (!source && !this.unknownReported.has(event.stream_id)) {
        this.unknownReported.add(event.stream_id);
        this.report(new WorkerEventTransportError("unattached-source", "Attach this worker using authoritative chat state before replay", event.stream_id));
      }
      this.scheduleFlush();
    } catch (error) { this.report(error); this.scheduleFlush(); }
  }

  private clearReconciliation(): void {
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  private scheduleReconciliation(): void {
    this.clearReconciliation();
    if (this.phase !== "running" || this.paused) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      // Schedule the next tick only after this serialized read has settled.
      void this.reconnect().catch(() => {}).finally(() => this.scheduleReconciliation());
    }, 2_000);
    (this.reconcileTimer as unknown as { unref?: () => void }).unref?.();
  }

  private scheduleFlush(): void {
    if (this.phase !== "running" || this.paused || this.flushScheduled) return;
    this.flushScheduled = true;
    void this.enqueue(async () => {
      this.flushScheduled = false;
      await this.synchronize(false);
    }).catch(() => {});
  }

  private async synchronize(listSources: boolean): Promise<void> {
    if (this.phase !== "running" || this.paused) return;
    if (listSources) {
      const expectedSources = [...this.sources.keys()];
      // A new host only has a small archive index cache. Ask it to resolve every
      // known stream from durable storage, including already retired workers.
      const listed = expectedSources.length
        ? await this.deps.rawInvoke("runtime_worker_sources", { streamIds: expectedSources })
        : await this.deps.rawInvoke("runtime_worker_sources");
      this.assertAlive();
      if (!Array.isArray(listed)) throw new WorkerEventTransportError("invalid-sources", "Invalid worker source list");
      const available = new Set<string>();
      for (const item of listed) {
        if (!item || !validId(item.streamId) || typeof item.runId !== "string" || !nonnegative(item.head)) throw new WorkerEventTransportError("invalid-sources", "Invalid worker source entry");
        available.add(item.streamId);
      }
      if (available.size > this.limits.maxSources) throw new WorkerEventTransportError("source-limit", "Too many discovered worker sources");
      for (const id of expectedSources) {
        if (!available.has(id)) throw new WorkerEventTransportError("source-unavailable", "A restored or attached worker archive is unavailable", id);
      }
      const initial = this.initialSources === undefined;
      if (initial) this.initialSources = this.restored ? new Set() : new Set(available);
      for (const item of listed) {
        // Fresh observers must not adopt pre-existing history. Once initialized,
        // new IDs represent missed starts; a restored snapshot also authorizes
        // catching up sources created after its checkpoint boundary.
        if (!this.sources.has(item.streamId) && (this.restored || !initial) && !this.initialSources!.has(item.streamId)) this.addSource(item.streamId, 0);
        const source = this.sources.get(item.streamId);
        if (source) {
          if (item.head < source.stream.cursor) throw new WorkerEventTransportError("source-regressed", "Worker archive head is behind its consumed cursor", item.streamId);
          source.target = Math.max(source.target, item.head);
        }
      }
    }
    // Snapshot the work set and replay target: continuous live traffic cannot
    // prolong a checkpoint barrier indefinitely.
    for (const [id, source] of [...this.sources]) {
      const queue = this.queues.get(id);
      const count = queue?.length ?? 0;
      for (let index = 0; index < count; index++) {
        const item = queue![0];
        const result = source.stream.push(item.event);
        if (!result.ok) throw new WorkerEventTransportError(result.error!.code, result.error!.message, id);
        queue!.shift();
        this.queuedCount--;
        this.queuedBytes -= item.bytes;
      }
      if (queue?.length === 0) this.queues.delete(id);
      const target = source.target;
      let pages = 0;
      while (source.stream.cursor < target || source.stream.needsReplay()) {
        if (++pages > this.limits.maxReplayPages) throw new WorkerEventTransportError("replay-limit", "Worker replay exceeded its page budget", id);
        const before = source.stream.cursor;
        const batch = await this.deps.rawInvoke("runtime_worker_events", { streamId: id, after: before, limit: this.limits.replayLimit }) as ReplayBatch;
        this.assertAlive();
        if (!batch || batch.stream_id !== id || !nonnegative(batch.through) || !Array.isArray(batch.events)) throw new WorkerEventTransportError("invalid-replay", "Invalid worker replay response", id);
        const result = source.stream.resume(batch);
        if (!result.ok) throw new WorkerEventTransportError(result.error!.code, result.error!.message, id);
        if (source.stream.cursor <= before && (source.stream.cursor < target || source.stream.needsReplay())) throw new WorkerEventTransportError("replay-stalled", "Worker replay made no progress", id);
      }
    }
  }
}
