import { describe, expect, it, vi } from "vitest";
import { SequencedEventStream, type EventEnvelope } from "./runtime-event-stream";

const event = (seq: number, payload: unknown = `片段${seq}😀`, stream_id = "epoch-a"): EventEnvelope => ({ stream_id, seq, name: "delta", payload });
const replay = (through: number, events: EventEnvelope[]) => ({ stream_id: "epoch-a", through, events });

describe("SequencedEventStream", () => {
  it("merges live frames received before replay without losing Chinese or emoji", () => {
    const emit = vi.fn();
    const stream = new SequencedEventStream(emit);
    expect(stream.push(event(3)).status).toBe("needs-replay");
    expect(stream.push(event(2)).status).toBe("needs-replay");
    expect(emit).not.toHaveBeenCalled();
    expect(stream.resume(replay(2, [event(1), event(2)])).status).toBe("ready");
    expect(emit.mock.calls).toEqual([["delta", "片段1😀"], ["delta", "片段2😀"], ["delta", "片段3😀"]]);
    expect(stream.cursor).toBe(3);
    expect(stream.streamId).toBe("epoch-a");
    expect(stream.needsReplay()).toBe(false);
  });

  it("orders frames, ignores consumed duplicates, and canonicalizes object member order", () => {
    const emit = vi.fn();
    const stream = new SequencedEventStream(emit);
    stream.push(event(2, { b: 2, a: 1 }));
    expect(stream.push(event(2, { a: 1, b: 2 })).ok).toBe(true);
    stream.push(event(1));
    expect(stream.push(event(1)).status).toBe("ready");
    expect(stream.resume(replay(2, [event(1), event(2)] )).ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting pending and replay duplicates before emitting", () => {
    const emit = vi.fn();
    const stream = new SequencedEventStream(emit);
    stream.push(event(2));
    expect(stream.push(event(2, "changed")).error?.code).toBe("conflicting-duplicate");
    expect(stream.resume(replay(2, [event(1), event(2, "changed")])).error?.code).toBe("conflicting-duplicate");
    expect(emit).not.toHaveBeenCalled();
    expect(stream.resume(replay(2, [event(1), event(2)])).ok).toBe(true);
    const fresh = new SequencedEventStream(emit);
    expect(fresh.resume(replay(1, [event(1), event(1, "changed")])).error?.code).toBe("conflicting-duplicate");
  });

  it("requires explicit reset for epoch changes", () => {
    const emit = vi.fn();
    const stream = new SequencedEventStream(emit, { streamId: "epoch-a", cursor: 5 });
    expect(stream.push(event(1, "new", "epoch-b")).error?.code).toBe("epoch-mismatch");
    expect(stream.resume({ stream_id: "epoch-b", through: 1, events: [] }).error?.code).toBe("epoch-mismatch");
    expect(stream.resume(replay(6, [event(6, "new", "epoch-b")])).error?.code).toBe("epoch-mismatch");
    expect(stream.cursor).toBe(5);
    stream.reset("epoch-b", 8);
    expect(stream.push(event(9, "new", "epoch-b")).ok).toBe(true);
    expect(stream.cursor).toBe(9);
  });

  it("rejects missing prefixes atomically and retains previously buffered live frames", () => {
    const emit = vi.fn();
    const stream = new SequencedEventStream(emit);
    stream.push(event(4));
    expect(stream.resume(replay(3, [event(1), event(3)])).error?.code).toBe("sequence-gap");
    expect(stream.cursor).toBe(0);
    expect(emit).not.toHaveBeenCalled();
    expect(stream.resume(replay(3, [event(1), event(2)])).error?.code).toBe("sequence-gap");
    expect(stream.resume(replay(3, [event(3), event(1), event(2)])).ok).toBe(true);
    expect(stream.cursor).toBe(4);
  });

  it("enforces count and UTF-8 byte bounds without silently dropping existing frames", () => {
    const emit = vi.fn();
    const stream = new SequencedEventStream(emit, { maxBufferedEvents: 2 });
    stream.push(event(3));
    stream.push(event(2));
    expect(stream.push(event(4)).error?.code).toBe("buffer-limit");
    expect(stream.cursor).toBe(0);
    expect(stream.needsReplay()).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(event(2))).byteLength;
    const limited = new SequencedEventStream(emit, { maxBufferedBytes: bytes - 1 });
    expect(limited.push(event(2)).error?.code).toBe("buffer-limit");
    expect(limited.cursor).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not advance a failed callback and retries the same original payload", () => {
    const emit = vi.fn().mockImplementationOnce((_name, payload) => { payload.text = "mutated"; throw new Error("failure"); });
    const stream = new SequencedEventStream(emit);
    expect(stream.push(event(1, { text: "原文😀" })).error?.code).toBe("emit-failed");
    expect(stream.cursor).toBe(0);
    expect(stream.resume(replay(1, [])).ok).toBe(true);
    expect(emit.mock.calls[1]).toEqual(["delta", { text: "原文😀" }]);
    expect(stream.cursor).toBe(1);
  });

  it.each([-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid event sequence %s", seq => {
    expect(new SequencedEventStream(vi.fn()).push(event(seq)).error?.code).toBe("invalid-event");
  });

  it("validates replay and snapshot cursors and does not guess a nonzero epoch", () => {
    const stream = new SequencedEventStream(vi.fn());
    expect(stream.resume(replay(Number.MAX_SAFE_INTEGER + 1, [])).error?.code).toBe("invalid-event");
    expect(stream.resume(replay(1, [event(2)])).error?.code).toBe("invalid-event");
    expect(stream.reset("epoch-a", -1).error?.code).toBe("invalid-event");
    expect(() => new SequencedEventStream(vi.fn(), { cursor: 5 })).toThrow();
    expect(() => new SequencedEventStream(vi.fn(), { maxBufferedEvents: 0 })).toThrow();
  });
});
