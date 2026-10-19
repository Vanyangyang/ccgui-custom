import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentAnswerState } from "./persistent-state";
import type { AnswerPersistence, AnswerSnapshot } from "./persistence";

vi.mock("@/lib/transport", () => ({ invoke: vi.fn() }));
const hash = "a".repeat(64);
const snapshot = (n: number, revision = 1): AnswerSnapshot => ({ revision, values: { $n: n }, sourceHash: hash });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("durable answer controller", () => {
  it("hydrates before updates, isolates source changes, and keeps cached values on remount", async () => {
    const load = deferred<AnswerSnapshot>();
    const api: AnswerPersistence = { read: vi.fn(() => load.promise), write: vi.fn() };
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, api);
    const off = state.subscribe(() => {});
    state.update({ $n: 9 });
    expect(state.getSnapshot().ready).toBe(false);
    off();
    const other = new PersistentAnswerState("id", "changed", { $n: 2 }, { ...api, read: async () => snapshot(7) });
    await other.load();
    load.resolve(snapshot(4)); await settle();
    expect(other.getSnapshot().values.$n).toBe(7);
    expect(state.getSnapshot().values.$n).toBe(4);
    state.subscribe(() => {})();
    expect(api.read).toHaveBeenCalledTimes(1);
  });
  it("serializes slow old saves and persists reset with the next revision", async () => {
    vi.useFakeTimers();
    const first = deferred<AnswerSnapshot>();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot(1, 3));
    const api: AnswerPersistence = { read: async () => snapshot(1), write };
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, api);
    await state.load();
    state.update({ $n: 2 }); await vi.advanceTimersByTimeAsync(250);
    state.update({ $n: 3 }); state.reset(); await vi.advanceTimersByTimeAsync(250);
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(snapshot(2, 2)); await settle();
    expect(write.mock.calls[1]).toEqual(["id", "source", 2, { $n: 1 }, true]);
    expect(state.getSnapshot().values.$n).toBe(1);
    expect(state.getSnapshot().status).toBe("saved");
  });
  it("retains a failed CAS intent and newer inputs instead of overwriting on retry", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("interactive_answer_conflict"));
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, { read: async () => snapshot(1, 8), write });
    await state.load();
    state.update({ $n: 2 }); await vi.advanceTimersByTimeAsync(250);
    state.update({ $n: 3 }); await vi.advanceTimersByTimeAsync(250);
    expect(write).toHaveBeenCalledTimes(1);
    state.retry(); await settle();
    expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
    expect(write.mock.calls[0][2]).toBe(8);
    expect(state.getSnapshot()).toMatchObject({ status: "conflict", values: { $n: 3 } });
  });
  it("retries the original CAS when a failed write never committed", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(snapshot(2, 2));
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, { read: async () => snapshot(1), write });
    await state.load(); state.update({ $n: 2 }); await vi.advanceTimersByTimeAsync(250);
    state.retry(); await settle();
    expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
    expect(state.getSnapshot()).toMatchObject({ status: "saved", values: { $n: 2 } });
  });
  it("does not overwrite a newer differing snapshot or erase conflict on failed verification", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(8, 2)).mockRejectedValueOnce(new Error("offline"));
    const write = vi.fn().mockRejectedValueOnce(new Error("reply lost"));
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, { read, write });
    await state.load(); state.update({ $n: 2 }); await vi.advanceTimersByTimeAsync(250);
    state.retry(); await settle(); expect(state.getSnapshot()).toMatchObject({ status: "conflict", values: { $n: 2 } });
    state.retry(); await settle(); expect(state.getSnapshot()).toMatchObject({ status: "conflict", values: { $n: 2 } });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("confirms a lost write reply with canonical values, then saves newer pending inputs", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce({ ...snapshot(1), values: { $n: 1, $b: false } })
      .mockResolvedValueOnce({ ...snapshot(2, 2), values: { $b: true, $n: 2 } });
    const write = vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValueOnce({ ...snapshot(3, 3), values: { $n: 3, $b: true } });
    const state = new PersistentAnswerState("id", "source", { $n: 1, $b: false }, { read, write });
    await state.load(); state.update({ $n: 2, $b: true }); await vi.advanceTimersByTimeAsync(250);
    state.update({ $n: 3, $b: true }); state.retry(); await settle();
    expect(read).toHaveBeenLastCalledWith("id", "source");
    expect(write.mock.calls[1]).toEqual(["id", "source", 2, { $n: 3, $b: true }, false]);
    expect(state.getSnapshot()).toMatchObject({ status: "saved", values: { $n: 3, $b: true } });
  });
  it("explicitly reloads saved values, clears blocked intents and resets the renderer generation", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(8, 9));
    const write = vi.fn().mockRejectedValueOnce(new Error("interactive_answer_conflict")).mockResolvedValueOnce(snapshot(10, 10));
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, { read, write });
    await state.load(); state.update({ $n: 2 }); await vi.advanceTimersByTimeAsync(250);
    state.update({ $n: 3 });
    await state.reloadSaved();
    expect(state.getSnapshot()).toMatchObject({ status: "saved", values: { $n: 8 }, generation: 1 });
    await vi.advanceTimersByTimeAsync(250); expect(write).toHaveBeenCalledTimes(1);
    state.update({ $n: 10 }); await vi.advanceTimersByTimeAsync(250);
    expect(write.mock.calls[1][2]).toBe(9);
  });
  it("keeps local values and failed/pending intents when explicit reload fails", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(snapshot(1)).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(snapshot(7, 8));
    const write = vi.fn().mockRejectedValue(new Error("interactive_answer_conflict"));
    const state = new PersistentAnswerState("id", "source", { $n: 1 }, { read, write });
    await state.load(); state.update({ $n: 2 }); await vi.advanceTimersByTimeAsync(250); state.update({ $n: 3 });
    await state.reloadSaved();
    expect(state.getSnapshot()).toMatchObject({ status: "loadError", values: { $n: 3 }, generation: 0, ready: true });
    await vi.advanceTimersByTimeAsync(250); expect(write).toHaveBeenCalledTimes(1);
    state.retry(); await settle();
    expect(state.getSnapshot()).toMatchObject({ status: "saved", values: { $n: 7 }, generation: 1 });
  });
  it("retries read failures truthfully and sanitizes invalid stored parameters", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...snapshot(1), values: { $n: Infinity, extra: "bad" } });
    const state = new PersistentAnswerState("id", "s", { $n: 5 }, { read, write: vi.fn() });
    await state.load();
    expect(state.getSnapshot()).toMatchObject({ status: "loadError", ready: false });
    state.retry(); await settle();
    expect(state.getSnapshot()).toMatchObject({ status: "saved", ready: true, values: { $n: 5 } });
  });
  it("flushes an unmounted pending edit only to its captured key and cancels its timer", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(snapshot(9, 2));
    const state = new PersistentAnswerState("old", "old-source", { $n: 1 }, { read: async () => snapshot(1), write });
    const off = state.subscribe(() => {}); await settle();
    state.update({ $n: 9 }); off(); await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledExactlyOnceWith("old", "old-source", 1, { $n: 9 }, false);
  });
});
