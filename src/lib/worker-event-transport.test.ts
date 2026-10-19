import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerEventTransport, type WorkerEventOptions } from "./worker-event-transport";
import type { EventEnvelope } from "./runtime-event-stream";

const event = (seq: number, stream_id = "worker-a", payload: unknown = `片段${seq}😀`): EventEnvelope => ({ stream_id, seq, name: "chat://delta", payload });
const adapters: WorkerEventTransport[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: WorkerEventOptions = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const archives = new Map<string, EventEnvelope[]>([["worker-a", []]]);
  const deliver = vi.fn();
  const onError = vi.fn();
  const order: string[] = [];
  const rawListen = vi.fn(async (name: string, callback: (payload: unknown) => void) => {
    order.push(name);
    listeners.set(name, callback);
    return () => { listeners.delete(name); };
  });
  const rawInvoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    order.push(command);
    if (command === "runtime_worker_sources") return [...archives].map(([streamId, events]) => ({ streamId, runId: `run-${streamId}`, head: events.at(-1)?.seq ?? 0 }));
    const id = args!.streamId as string;
    const after = args!.after as number;
    const events = (archives.get(id) ?? []).filter(item => item.seq > after).slice(0, args!.limit as number);
    return { stream_id: id, through: events.at(-1)?.seq ?? after, events };
  });
  const adapter = new WorkerEventTransport({ rawInvoke, rawListen, deliver, onError }, options);
  adapters.push(adapter);
  const live = (value: EventEnvelope) => listeners.get("runtime://worker-event")!(value);
  return { adapter, archives, listeners, rawInvoke, rawListen, deliver, onError, order, live };
}

describe("WorkerEventTransport", () => {
  it("listens before discovery and resumes a restored cursor across reconnect duplicates", async () => {
    const f = fixture();
    f.archives.set("worker-a", [event(1), event(2)]);
    f.adapter.restoreCursors({ "worker-a": 1 });
    await f.adapter.start();
    expect(f.order.slice(0, 3)).toEqual(["runtime://worker-event", "transport://connected", "runtime_worker_sources"]);
    expect(f.deliver.mock.calls).toEqual([["chat://delta", "片段2😀", { streamId: "worker-a", seq: 2 }]]);
    f.archives.get("worker-a")!.push(event(3), event(4));
    f.live(event(4));
    f.live(event(2));
    f.listeners.get("transport://connected")!(null);
    await f.adapter.pause();
    expect(f.deliver.mock.calls.map((call: unknown[]) => call[1])).toEqual(["片段2😀", "片段3😀", "片段4😀"]);
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 4 });
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("merges live traffic arriving while discovery and replay are awaiting", async () => {
    const f = fixture();
    const sources = deferred<unknown>();
    const replay = deferred<unknown>();
    f.rawInvoke.mockImplementationOnce(() => sources.promise).mockImplementationOnce(() => replay.promise);
    f.adapter.restoreCursors({ "worker-a": 0 });
    const starting = f.adapter.start();
    await vi.waitFor(() => expect(f.rawInvoke).toHaveBeenCalledTimes(1));
    f.live(event(3));
    sources.resolve([{ streamId: "worker-a", runId: "run-a", head: 2 }]);
    await vi.waitFor(() => expect(f.rawInvoke).toHaveBeenCalledTimes(2));
    f.live(event(2));
    replay.resolve({ stream_id: "worker-a", through: 2, events: [event(1), event(2)] });
    await starting;
    await f.adapter.pause();
    expect(f.deliver.mock.calls.map((call: unknown[]) => call[1])).toEqual(["片段1😀", "片段2😀", "片段3😀"]);
    expect(f.adapter.captureCursors()["worker-a"]).toBe(3);
  });

  it("waits for a replay boundary, freezes checkpoint cursors, and drains after resume", async () => {
    const f = fixture();
    f.adapter.restoreCursors({ "worker-a": 0 });
    await f.adapter.start();
    f.archives.set("worker-a", [event(1), event(2)]);
    const replay = deferred<unknown>();
    const normal = f.rawInvoke.getMockImplementation()!;
    f.rawInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => command === "runtime_worker_events" ? replay.promise : normal(command, args));
    const reconnect = f.adapter.reconnect();
    await vi.waitFor(() => expect(f.rawInvoke).toHaveBeenCalledWith("runtime_worker_events", expect.anything()));
    let paused = false;
    const checkpoint = f.adapter.pause().then(() => { paused = true; });
    await Promise.resolve();
    expect(paused).toBe(false);
    replay.resolve({ stream_id: "worker-a", through: 2, events: [event(1), event(2)] });
    await reconnect;
    await checkpoint;
    f.live(event(3));
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2 });
    expect(f.deliver).toHaveBeenCalledTimes(2);
    f.rawInvoke.mockImplementation(normal);
    f.archives.get("worker-a")!.push(event(3));
    await f.adapter.resume();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 3 });
    expect(() => f.adapter.restoreCursors({})).toThrow();
  });

  it("does not replay unknown historical archives, and requires attachment for unknown later frames", async () => {
    const f = fixture();
    f.archives.set("worker-a", [event(1), event(2)]);
    await f.adapter.start();
    expect(f.deliver).not.toHaveBeenCalled();
    f.live(event(2));
    await f.adapter.pause();
    expect(f.onError.mock.calls[0][0].code).toBe("unattached-source");
    expect(f.adapter.captureCursors()).toEqual({});
    f.adapter.attachSource("worker-a");
    await f.adapter.resume();
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2 });
  });

  it("attaches a new live worker sequence 1 and preserves independent cursors", async () => {
    const f = fixture();
    await f.adapter.start();
    f.live(event(1));
    f.live(event(1, "worker-b"));
    f.live(event(2));
    await f.adapter.pause();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2, "worker-b": 1 });
    expect(f.deliver).toHaveBeenCalledTimes(3);
  });

  it("retries throwing delivery without advancing the failed cursor", async () => {
    const f = fixture();
    f.adapter.restoreCursors({ "worker-a": 0 });
    await f.adapter.start();
    f.archives.set("worker-a", [event(1)]);
    f.deliver.mockImplementation(() => { throw new Error("consumer failed"); });
    f.live(event(1));
    await expect(f.adapter.pause()).rejects.toMatchObject({ code: "emit-failed" });
    expect(f.adapter.captureCursors()["worker-a"]).toBe(0);
    expect(f.onError.mock.calls.at(-1)![0].code).toBe("emit-failed");
    f.deliver.mockImplementation(() => {});
    await f.adapter.resume();
    expect(f.adapter.captureCursors()["worker-a"]).toBe(1);
    expect(f.deliver).toHaveBeenCalledTimes(3);
  });

  it("bounds unknown sources and paused queues with explicit errors", async () => {
    const f = fixture({ maxSources: 1, maxQueuedEvents: 1 });
    await f.adapter.start();
    await f.adapter.pause();
    f.live(event(2));
    f.live(event(3));
    f.live(event(2, "worker-b"));
    expect(f.onError.mock.calls.map(call => call[0].code)).toEqual(["unattached-source", "queue-limit", "source-limit"]);
    expect(f.deliver).not.toHaveBeenCalled();
    const small = fixture({ maxBufferedBytes: 10 });
    await small.adapter.start();
    small.live(event(1));
    expect(small.onError.mock.calls.at(-1)![0].code).toBe("queue-limit");
  });

  it("rejects a missing replay prefix without advancing and never spins on an empty page", async () => {
    const f = fixture();
    f.adapter.restoreCursors({ "worker-a": 0 });
    f.archives.set("worker-a", [event(2)]);
    await expect(f.adapter.start()).rejects.toMatchObject({ code: "sequence-gap" });
    expect(f.adapter.captureCursors()["worker-a"]).toBe(0);
    f.rawInvoke.mockResolvedValueOnce([{ streamId: "worker-a", runId: "run-a", head: 2 }]).mockResolvedValueOnce({ stream_id: "worker-a", through: 0, events: [] });
    await expect(f.adapter.start()).rejects.toMatchObject({ code: "replay-stalled" });
    expect(f.rawInvoke).toHaveBeenCalledTimes(4);
  });

  it("serializes paged replay and concurrent reconnect calls", async () => {
    const f = fixture({ replayLimit: 1 });
    f.archives.set("worker-a", [event(1), event(2), event(3)]);
    f.adapter.restoreCursors({ "worker-a": 0 });
    await Promise.all([f.adapter.start(), f.adapter.reconnect(), f.adapter.reconnect()]);
    const replays = f.rawInvoke.mock.calls.filter((call: unknown[]) => call[0] === "runtime_worker_events");
    expect(replays.map(call => call[1]?.after)).toEqual([0, 1, 2]);
    expect(f.deliver).toHaveBeenCalledTimes(3);
  });

  it("ignores late replay results and unregisters listeners on disposal", async () => {
    const f = fixture();
    const replay = deferred<unknown>();
    f.adapter.restoreCursors({ "worker-a": 0 });
    f.rawInvoke.mockResolvedValueOnce([{ streamId: "worker-a", runId: "run-a", head: 1 }]).mockImplementationOnce(() => replay.promise);
    const starting = f.adapter.start();
    const rejected = expect(starting).rejects.toMatchObject({ code: "disposed" });
    await vi.waitFor(() => expect(f.rawInvoke).toHaveBeenCalledTimes(2));
    f.adapter.dispose();
    replay.resolve({ stream_id: "worker-a", through: 1, events: [event(1)] });
    await rejected;
    expect(f.listeners.size).toBe(0);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.adapter.captureCursors()["worker-a"]).toBe(0);
  });

  it("reports unavailable restored archives without resetting cursors", async () => {
    const f = fixture();
    f.adapter.restoreCursors({ "retired-worker": 19 });
    await expect(f.adapter.start()).rejects.toMatchObject({ code: "source-unavailable", streamId: "retired-worker" });
    expect(f.rawInvoke).toHaveBeenCalledWith("runtime_worker_sources", { streamIds: ["retired-worker"] });
    expect(f.adapter.captureCursors()).toEqual({ "retired-worker": 19 });
  });

  it("retains cursors for 257 sequential retired sources and suppresses repeated sequence 1 and 2", async () => {
    const f = fixture();
    await f.adapter.start();
    for (let index = 0; index < 257; index++) {
      const id = `retired-${index}`;
      const events = [event(1, id, `${id}:1`), event(2, id, `${id}:2`)];
      f.archives.set(id, events);
      for (const frame of [...events, ...events]) f.live(frame);
      // Flush before the next source appears: the limit must cover lifetime
      // cursors, not just concurrently running workers or buffered payloads.
      await f.adapter.reconnect();
    }
    await f.adapter.pause();
    const cursors = f.adapter.captureCursors();
    expect(Object.keys(cursors)).toHaveLength(257);
    expect(Object.values(cursors).every(cursor => cursor === 2)).toBe(true);
    expect(f.deliver).toHaveBeenCalledTimes(514);
    expect(new Set(f.deliver.mock.calls.map((call: unknown[]) => call[1])).size).toBe(514);
    // Late duplicates of the oldest closed source still cannot restart it.
    f.live(event(1, "retired-0", "retired-0:1"));
    f.live(event(2, "retired-0", "retired-0:2"));
    await f.adapter.resume();
    expect(f.deliver).toHaveBeenCalledTimes(514);
    expect(f.onError).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it("restores a paused snapshot on a fresh host whose retired archives require explicit stream IDs", async () => {
    const old = fixture();
    await old.adapter.start();
    old.archives.set("retired-a", [event(1, "retired-a")]);
    old.archives.set("retired-b", [event(1, "retired-b"), event(2, "retired-b")]);
    old.live(event(1, "retired-a"));
    old.live(event(1, "retired-b"));
    old.live(event(2, "retired-b"));
    await old.adapter.pause();
    const cursors = old.adapter.captureCursors();
    old.adapter.dispose();

    const next = fixture();
    next.archives.set("retired-a", [event(1, "retired-a"), event(2, "retired-a")]);
    next.archives.set("retired-b", [event(1, "retired-b"), event(2, "retired-b"), event(3, "retired-b")]);
    const normal = next.rawInvoke.getMockImplementation()!;
    next.rawInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "runtime_worker_sources") return normal(command, args);
      // The new process has no in-memory index entries for retired archives.
      // An unscoped discovery cannot see them, even though disk replay exists.
      const requested = Array.isArray(args?.streamIds) ? args.streamIds as string[] : [];
      return requested.filter(id => next.archives.has(id)).map(id => ({
        streamId: id, runId: `run-${id}`, head: next.archives.get(id)!.at(-1)!.seq,
      }));
    });
    next.adapter.restoreCursors(cursors);
    await next.adapter.start();
    expect(next.rawInvoke).toHaveBeenCalledWith("runtime_worker_sources", { streamIds: ["retired-a", "retired-b"] });
    expect(next.deliver.mock.calls).toEqual([
      ["chat://delta", "片段2😀", { streamId: "retired-a", seq: 2 }],
      ["chat://delta", "片段3😀", { streamId: "retired-b", seq: 3 }],
    ]);
    next.live(event(1, "retired-a"));
    next.live(event(2, "retired-a"));
    await next.adapter.pause();
    expect(next.adapter.captureCursors()).toEqual({ "retired-a": 2, "retired-b": 3 });
    expect(next.deliver).toHaveBeenCalledTimes(2);
    expect(next.onError).not.toHaveBeenCalled();

    next.archives.delete("retired-b");
    await expect(next.adapter.resume()).rejects.toMatchObject({ code: "source-unavailable", streamId: "retired-b" });
    expect(next.adapter.captureCursors()).toEqual({ "retired-a": 2, "retired-b": 3 });
    next.adapter.dispose();
  });

  it("keeps the default lifetime source bound at 4096 without silently evicting cursors", () => {
    const f = fixture();
    const cursors = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`retired-${index}`, 2]));
    f.adapter.restoreCursors(cursors);
    expect(() => f.adapter.attachSource("one-too-many")).toThrow(expect.objectContaining({ code: "source-limit" }));
    expect(f.adapter.captureCursors()).toEqual(cursors);
    expect(() => f.adapter.restoreCursors({ ...cursors, "one-too-many": 1 })).toThrow(expect.objectContaining({ code: "source-limit" }));
    expect(f.adapter.captureCursors()).toEqual(cursors);
    f.adapter.dispose();
  });

  it("releases consumed payload budget while retaining source cursors", async () => {
    const f = fixture({ maxBufferedBytes: 2048 });
    await f.adapter.start();
    // Each payload fits by itself, but the lifetime total greatly exceeds the
    // queue budget. No consumer mock is allowed to retain those payloads here.
    f.deliver.mockImplementation(() => {});
    for (let index = 0; index < 20; index++) {
      const id = `completed-${index}`;
      f.live(event(1, id, "x".repeat(1024)));
      await f.adapter.pause();
      expect(f.adapter.captureCursors()[id]).toBe(1);
      f.deliver.mockClear();
      f.archives.set(id, []);
      // Advertise the consumed head without retaining a payload in this fixture.
      const listed = Object.keys(f.adapter.captureCursors()).map(streamId => ({ streamId, runId: `run-${streamId}`, head: 1 }));
      f.rawInvoke.mockResolvedValueOnce(listed);
      await f.adapter.resume();
    }
    expect(Object.keys(f.adapter.captureCursors())).toHaveLength(20);
    expect(f.onError).not.toHaveBeenCalled();
    f.adapter.dispose();
  });

  it("rejects an archive whose head regressed behind the persisted cursor", async () => {
    const f = fixture();
    f.adapter.restoreCursors({ "worker-a": 5 });
    f.archives.set("worker-a", [event(1)]);
    await expect(f.adapter.start()).rejects.toMatchObject({ code: "source-regressed" });
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 5 });
  });

  it("accepts a valid complete event larger than the old 8 MiB buffer", async () => {
    const f = fixture();
    await f.adapter.start();
    f.live(event(1, "worker-a", "x".repeat(9 * 1024 * 1024)));
    await f.adapter.pause();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 1 });
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("replays sources first discovered after initialization without adopting baseline history", async () => {
    const f = fixture();
    f.archives.set("worker-a", [event(1), event(2)]);
    await f.adapter.start();
    f.archives.set("retired-during-disconnect", [event(1, "retired-during-disconnect"), event(2, "retired-during-disconnect")]);
    await f.adapter.reconnect();
    expect(f.adapter.captureCursors()).toEqual({ "retired-during-disconnect": 2 });
    expect(f.deliver.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      { streamId: "retired-during-disconnect", seq: 1 }, { streamId: "retired-during-disconnect", seq: 2 },
    ]);
    await f.adapter.reconnect();
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });

  it("uses a restored snapshot's authority for sources created after its captured cursors", async () => {
    const f = fixture();
    f.archives.set("worker-a", [event(1)]);
    f.archives.set("worker-new", [event(1, "worker-new")]);
    f.adapter.restoreCursors({ "worker-a": 1 });
    await f.adapter.start();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 1, "worker-new": 1 });
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith("chat://delta", "片段1😀", { streamId: "worker-new", seq: 1 });
  });

  it("reconciles a lost final event at the next watermark without another live frame", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.adapter.start();
    f.archives.set("worker-a", [event(1)]);
    f.live(event(1));
    await f.adapter.reconnect();
    f.archives.get("worker-a")!.push({ ...event(2), name: "engine://event", payload: { type: "done" } });
    const before = f.rawInvoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.rawInvoke).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.deliver).toHaveBeenLastCalledWith("engine://event", { type: "done" }, { streamId: "worker-a", seq: 2 });
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2 });
  });

  it("repairs a queue-overflow final event from its recorded replay target", async () => {
    const f = fixture({ maxQueuedEvents: 1 });
    await f.adapter.start();
    f.archives.set("worker-a", [event(1), event(2)]);
    f.live(event(1));
    f.live(event(2));
    await f.adapter.pause();
    expect(f.onError.mock.calls.some((call: unknown[]) => (call[0] as { code: string }).code === "queue-limit")).toBe(true);
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2 });
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });

  it("does not consume periodic watermarks while paused or after disposal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.adapter.start();
    f.archives.set("worker-a", [event(1)]);
    f.live(event(1));
    await f.adapter.pause();
    f.archives.get("worker-a")!.push(event(2));
    const before = f.rawInvoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.rawInvoke).toHaveBeenCalledTimes(before);
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 1 });
    await f.adapter.resume();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2 });
    const pending = deferred<unknown>();
    f.rawInvoke.mockImplementationOnce(() => pending.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    const inFlight = f.rawInvoke.mock.calls.length;
    f.adapter.dispose();
    pending.resolve([{ streamId: "worker-a", runId: "run-a", head: 3 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.rawInvoke).toHaveBeenCalledTimes(inFlight);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries startup after partial replay failure without resetting consumed cursors or replaying committed callbacks", async () => {
    vi.useFakeTimers();
    const f = fixture({ replayLimit: 1 });
    f.archives.set("worker-a", [event(1), event(2)]);
    f.adapter.restoreCursors({ "worker-a": 0 });
    const normal = f.rawInvoke.getMockImplementation()!;
    let fail = true;
    f.rawInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "runtime_worker_events" && args?.after === 1 && fail) throw new Error("temporary archive read failure");
      return normal(command, args);
    });
    await expect(f.adapter.start()).rejects.toThrow("temporary archive read failure");
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 1 });
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => f.adapter.restoreCursors({ "worker-a": 0 })).toThrow(expect.objectContaining({ code: "already-started" }));
    fail = false;
    await f.adapter.start();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 2 });
    expect(f.deliver.mock.calls.map((call: unknown[]) => call[1])).toEqual(["片段1😀", "片段2😀"]);
    expect(f.listeners.size).toBe(2);
    f.adapter.dispose();
    expect(() => f.adapter.start()).toThrow(expect.objectContaining({ code: "disposed" }));
  });

  it("ignores callbacks from a failed listener generation after retry", async () => {
    const f = fixture();
    const captured: ((payload: unknown) => void)[] = [];
    const normal = f.rawListen.getMockImplementation()!;
    let fail = true;
    f.rawListen.mockImplementation(async (name: string, callback: (payload: unknown) => void) => {
      if (name === "runtime://worker-event") captured.push(callback);
      if (name === "transport://connected" && fail) throw new Error("listener unavailable");
      return normal(name, callback);
    });
    await expect(f.adapter.start()).rejects.toThrow("listener unavailable");
    fail = false;
    await f.adapter.start();
    captured[0](event(1, "stale-worker"));
    f.live(event(1));
    await f.adapter.pause();
    expect(f.adapter.captureCursors()).toEqual({ "worker-a": 1 });
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
});
