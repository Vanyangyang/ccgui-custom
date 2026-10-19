export interface EventEnvelope {
  stream_id: string;
  seq: number;
  name: string;
  payload: unknown;
}

export interface ReplayBatch {
  stream_id: string;
  through: number;
  events: EventEnvelope[];
}

export type StreamErrorCode = "invalid-event" | "epoch-mismatch" | "sequence-gap" |
  "conflicting-duplicate" | "buffer-limit" | "emit-failed" | "reentrant-call";

export interface StreamResult {
  ok: boolean;
  status: "ready" | "needs-replay" | "error";
  streamId: string | undefined;
  cursor: number;
  error?: { code: StreamErrorCode; message: string };
}

export interface StreamOptions {
  streamId?: string;
  cursor?: number;
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
}

type Entry = { event: EventEnvelope; fingerprint: string; bytes: number };

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// The wire protocol is JSON. Sorting keys makes object member order irrelevant.
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || seen.has(value)) throw new Error("Payload must be finite, acyclic JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item, seen)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Payload must be JSON");
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * No I/O: callers own subscription, replay requests, and authoritative snapshots.
 * emit must commit atomically: a throwing callback will be retried and must not
 * have already produced irreversible side effects. The authenticated host owns
 * immutable sequence identities; already consumed sequences are ignored.
 */
export class SequencedEventStream {
  private id: string | undefined;
  private position: number;
  private pending = new Map<number, Entry>();
  private fault = false;
  private busy = false;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(private readonly emit: (name: string, payload: unknown) => void, options: StreamOptions = {}) {
    this.id = options.streamId;
    this.position = options.cursor ?? 0;
    this.maxEvents = options.maxBufferedEvents ?? 4096;
    this.maxBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
    if (!integer(this.position) || (this.id !== undefined && (typeof this.id !== "string" || !this.id)) || (!this.id && this.position !== 0)) throw new Error("Invalid initial stream cursor");
    if (!integer(this.maxEvents) || this.maxEvents === 0 || !integer(this.maxBytes) || this.maxBytes === 0) throw new Error("Invalid buffer limits");
  }

  get cursor(): number { return this.position; }
  get streamId(): string | undefined { return this.id; }
  needsReplay(): boolean { return this.fault || this.pending.size > 0; }

  /** Only call after installing an authoritative snapshot for this exact cursor. */
  reset(streamId: string, cursor: number): StreamResult {
    if (this.busy) return this.fail("reentrant-call", "Cannot reset while emitting");
    if (typeof streamId !== "string" || !streamId || !integer(cursor)) return this.fail("invalid-event", "Invalid snapshot cursor");
    this.id = streamId;
    this.position = cursor;
    this.pending.clear();
    this.fault = false;
    return this.result();
  }

  push(envelope: EventEnvelope): StreamResult {
    return this.merge(envelope?.stream_id, [envelope]);
  }

  resume(batch: ReplayBatch): StreamResult {
    if (!batch || !integer(batch.through) || !Array.isArray(batch.events)) return this.fail("invalid-event", "Invalid replay batch");
    return this.merge(batch.stream_id, batch.events, batch.through);
  }

  private merge(streamId: string, events: EventEnvelope[], through?: number): StreamResult {
    if (this.busy) return this.fail("reentrant-call", "Cannot merge while emitting");
    if (typeof streamId !== "string" || !streamId) return this.fail("invalid-event", "Missing stream ID");
    if (this.id !== undefined && streamId !== this.id) return this.fail("epoch-mismatch", "Stream changed; an authoritative snapshot is required");
    const merged = new Map(this.pending);
    let bytes = 0;
    for (const entry of merged.values()) bytes += entry.bytes;
    for (const event of events) {
      if (!event || event.stream_id !== streamId) return this.fail("epoch-mismatch", "Replay contains another stream");
      if (!integer(event.seq) || event.seq === 0 || typeof event.name !== "string" || !event.name || (through !== undefined && event.seq > through)) return this.fail("invalid-event", "Invalid event sequence or name");
      if (event.seq <= this.position) continue;
      let entry: Entry;
      try {
        const fingerprint = canonical(event);
        entry = { event: JSON.parse(fingerprint) as EventEnvelope, fingerprint, bytes: new TextEncoder().encode(fingerprint).byteLength };
      } catch {
        return this.fail("invalid-event", "Event is not valid JSON");
      }
      const prior = merged.get(event.seq);
      if (prior && prior.fingerprint !== entry.fingerprint) return this.fail("conflicting-duplicate", "Sequence has conflicting content");
      if (!prior) bytes += entry.bytes;
      merged.set(event.seq, entry);
      if (merged.size > this.maxEvents) return this.fail("buffer-limit", "Event buffer count exceeded");
      if (bytes > this.maxBytes) return this.fail("buffer-limit", "Event buffer bytes exceeded");
    }
    if (through !== undefined && through > this.position) {
      const prefix = [...merged.keys()].filter(seq => seq <= through).sort((a, b) => a - b);
      let expected = this.position + 1;
      for (const seq of prefix) {
        if (seq !== expected) return this.fail("sequence-gap", "Replay is missing a contiguous prefix");
        expected++;
      }
      if (expected - 1 !== through) return this.fail("sequence-gap", "Replay is missing its final prefix event");
    }
    this.id = streamId;
    this.pending = merged;
    if (through !== undefined) this.fault = false;
    this.busy = true;
    try {
      while (this.position < Number.MAX_SAFE_INTEGER) {
        const entry = this.pending.get(this.position + 1);
        if (!entry) break;
        try { this.emit(entry.event.name, JSON.parse(entry.fingerprint).payload); }
        catch { return this.fail("emit-failed", "Event consumer threw; cursor was not advanced"); }
        this.position = entry.event.seq;
        this.pending.delete(this.position);
      }
    } finally { this.busy = false; }
    return this.result();
  }

  private result(): StreamResult {
    return { ok: true, status: this.needsReplay() ? "needs-replay" : "ready", streamId: this.id, cursor: this.position };
  }

  private fail(code: StreamErrorCode, message: string): StreamResult {
    this.fault = true;
    return { ok: false, status: "error", streamId: this.id, cursor: this.position, error: { code, message } };
  }
}
