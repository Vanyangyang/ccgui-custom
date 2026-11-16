import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), isWeb: false }));
vi.mock("@/lib/runtime-checkpoint", () => ({ holdRuntimeSubmissions: vi.fn(() => vi.fn()) }));
vi.mock("./activity", () => ({ readTaskShutdownBusy: () => false }));
import { createTaskShutdownStore, type TaskShutdownStatus } from "./runtime";

const status = (phase: TaskShutdownStatus["phase"] = "off", generation = 1): TaskShutdownStatus => ({ supported: true, phase, generation, remainingSeconds: phase === "countdown" ? 60 : null, blockers: [], error: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("task shutdown runtime (mock IPC only)", () => {
  const disposers: Array<() => void> = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => { disposers.splice(0).forEach(stop => stop()); await flush(); vi.useRealTimers(); });
  function setup(initial = status(), holdSubmissions?: () => () => void) {
    const native = vi.fn(async (command: string, args?: Record<string, unknown>) => command === "task_shutdown_set" ? status(args?.enabled ? "waiting" : "off", 2) : initial);
    const busy = vi.fn(() => false);
    const store = createTaskShutdownStore({ invoke: native as never, readBusy: busy, holdSubmissions });
    disposers.push(store.getState().start());
    return { native, busy, store };
  }
  it("arms explicitly, samples current activity on each pulse, and cancels", async () => {
    const { native, busy, store } = setup(); await flush();
    expect(store.getState().status?.phase).toBe("off");
    await store.getState().setEnabled(true);
    busy.mockReturnValue(true);
    native.mockResolvedValueOnce(status("waiting", 2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native).toHaveBeenLastCalledWith("task_shutdown_poll", { generation: 2, frontendBusy: true, allowShutdown: false });
    await store.getState().setEnabled(false);
    expect(store.getState().status?.phase).toBe("off");
    const count = native.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(native).toHaveBeenCalledTimes(count);
  });
  it("resumes an existing host plan and polls even while hidden", async () => {
    const { native } = setup(status("countdown", 7)); await flush();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native).toHaveBeenLastCalledWith("task_shutdown_poll", { generation: 7, frontendBusy: false, allowShutdown: false });
    hidden.mockRestore();
  });
  it("keeps polls serial and lets cancellation bypass a stalled poll and its stale reply", async () => {
    const { native, store } = setup(status("waiting")); await flush();
    const delayed = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(delayed.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_poll")).toHaveLength(1);
    await store.getState().setEnabled(false);
    expect(store.getState().status?.phase).toBe("off");
    delayed.resolve(status("countdown")); await flush();
    expect(store.getState().status?.phase).toBe("off");
  });
  it("ignores an initial status reply after a newer explicit switch", async () => {
    const delayed = deferred<TaskShutdownStatus>();
    const native = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(status("waiting", 5));
    const store = createTaskShutdownStore({ invoke: native, readBusy: () => false });
    disposers.push(store.getState().start());
    await store.getState().setEnabled(true);
    delayed.resolve(status()); await flush();
    expect(store.getState().status?.generation).toBe(5);
  });
  it("coalesces double enable and serializes a following cancellation", async () => {
    const { native, store } = setup(); await flush();
    const delayed = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(delayed.promise);
    const first = store.getState().setEnabled(true);
    const second = store.getState().setEnabled(true);
    const cancel = store.getState().setEnabled(false);
    await flush();
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_set")).toHaveLength(1);
    delayed.resolve(status("waiting")); await Promise.all([first, second, cancel]);
    expect(store.getState().status?.phase).toBe("off");
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_set").map(([, args]) => args?.enabled)).toEqual([true, false]);
  });
  it("disposes timers and cancels after an in-flight arm settles", async () => {
    const { native, store } = setup(); await flush();
    const delayed = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(delayed.promise);
    const arm = store.getState().setEnabled(true); await flush();
    store.getState().dispose(); await flush();
    expect(native.mock.calls.filter(([, args]) => args?.enabled === false)).toHaveLength(0);
    delayed.resolve(status("waiting")); await arm; await flush();
    expect(native.mock.calls.filter(([, args]) => args?.enabled === false)).toHaveLength(1);
    const count = native.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native).toHaveBeenCalledTimes(count);
    expect(store.getState().desiredEnabled).toBe(false);
  });
  it("orders StrictMode cleanup after a late old arm and before a new mount's arm", async () => {
    const { native, store } = setup(); await flush();
    const delayed = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(delayed.promise);
    const oldArm = store.getState().setEnabled(true); await flush();
    store.getState().dispose();
    disposers.push(store.getState().start());
    const newArm = store.getState().setEnabled(true); await flush();
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_set")).toHaveLength(1);
    delayed.resolve(status("waiting", 1)); await oldArm; await newArm; await flush();
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_set").map(([, args]) => args?.enabled)).toEqual([true, false, true]);
    expect(store.getState().status?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native).toHaveBeenLastCalledWith("task_shutdown_poll", { generation: 2, frontendBusy: false, allowShutdown: false });
  });
  it("orders failure cleanup before a retry even when cancellation replies late", async () => {
    const { native, store } = setup(status("waiting")); await flush();
    const cancelled = deferred<TaskShutdownStatus>();
    native.mockRejectedValueOnce(new Error("poll failed")).mockReturnValueOnce(cancelled.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState().status?.phase).toBe("failed");
    const retry = store.getState().setEnabled(true); await flush();
    expect(native).toHaveBeenLastCalledWith("task_shutdown_set", { enabled: false });
    cancelled.resolve(status("off")); await retry; await flush();
    expect(native).toHaveBeenLastCalledWith("task_shutdown_set", { enabled: true });
    expect(store.getState().status?.phase).toBe("waiting");
  });
  it("isolates a stalled old poll from new lifecycle polling and ignores its late reply", async () => {
    const { native, store } = setup(status("waiting")); await flush();
    const oldPoll = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(oldPoll.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    store.getState().dispose(); disposers.push(store.getState().start());
    await store.getState().setEnabled(true); await flush();
    const newPoll = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(newPoll.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_poll")).toHaveLength(2);
    oldPoll.resolve(status("requested", 1)); await flush();
    expect(store.getState().status?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_poll")).toHaveLength(2);
    newPoll.resolve(status("waiting", 2)); await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.mock.calls.filter(([command]) => command === "task_shutdown_poll")).toHaveLength(3);
  });
  it("fails visibly for old hosts, malformed statuses, and poll errors without retrying arm", async () => {
    const native = vi.fn().mockRejectedValue(new Error("command task_shutdown_status not found"));
    const store = createTaskShutdownStore({ invoke: native, readBusy: () => false });
    disposers.push(store.getState().start()); await flush();
    expect(store.getState().status).toMatchObject({ supported: true, phase: "failed" });
    native.mockResolvedValueOnce({}); await store.getState().setEnabled(true);
    expect(store.getState().status?.error).toBe("Invalid task shutdown status");
    const other = setup(status("waiting")); await flush();
    other.native.mockRejectedValueOnce(new Error("IPC disconnected"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(other.store.getState().status?.phase).toBe("failed");
    expect(other.native.mock.calls.filter(([command]) => command === "task_shutdown_poll")).toHaveLength(1);
  });
  it("fails closed if activity sampling throws", async () => {
    const { busy, native, store } = setup(status("waiting")); await flush();
    busy.mockImplementation(() => { throw new Error("activity unavailable"); });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState().status?.phase).toBe("failed");
    expect(native.mock.calls.some(([command]) => command === "task_shutdown_poll")).toBe(false);
  });
  it("requires a submission hold on a later pulse after the countdown reaches zero", async () => {
    const release = vi.fn(); const hold = vi.fn(() => release);
    const { native, store } = setup({ ...status("countdown", 8), remainingSeconds: 2 }, hold); await flush();
    native.mockResolvedValueOnce({ ...status("countdown", 8), remainingSeconds: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hold).not.toHaveBeenCalled();
    expect(native).toHaveBeenLastCalledWith("task_shutdown_poll", { generation: 8, frontendBusy: false, allowShutdown: false });
    expect(store.getState().status?.remainingSeconds).toBe(0);
    native.mockImplementationOnce(async (command, args) => {
      expect(command).toBe("task_shutdown_poll");
      expect(hold).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(args).toEqual({ generation: 8, frontendBusy: false, allowShutdown: true });
      return status("requested", 8);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getState().status?.phase).toBe("requested");
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("does not hold or permit shutdown when fresh activity is busy at the deadline", async () => {
    const hold = vi.fn(() => vi.fn());
    const { native, busy } = setup({ ...status("countdown"), remainingSeconds: 0 }, hold); await flush();
    busy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hold).not.toHaveBeenCalled();
    expect(native).toHaveBeenLastCalledWith("task_shutdown_poll", { generation: 1, frontendBusy: true, allowShutdown: false });
  });
  it("keeps the hold until native returns and releases it exactly once", async () => {
    const release = vi.fn(); const hold = vi.fn(() => release);
    const { native } = setup({ ...status("countdown"), remainingSeconds: 1 }, hold); await flush();
    const poll = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(poll.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenLastCalledWith("task_shutdown_poll", { generation: 1, frontendBusy: false, allowShutdown: true });
    expect(release).not.toHaveBeenCalled();
    poll.resolve(status("requested")); await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(["cancel", "dispose"] as const)("releases the hold on %s acknowledgement while the old poll is still pending", async action => {
    const release = vi.fn(); const hold = vi.fn(() => release);
    const { native, store } = setup({ ...status("countdown"), remainingSeconds: 0 }, hold); await flush();
    const poll = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(poll.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    const cancellation = deferred<TaskShutdownStatus>(); native.mockReturnValueOnce(cancellation.promise);
    const done = action === "cancel" ? store.getState().setEnabled(false) : store.getState().dispose();
    await flush();
    expect(native).toHaveBeenLastCalledWith("task_shutdown_set", { enabled: false });
    expect(release).not.toHaveBeenCalled();
    cancellation.resolve(status("off")); await done; await flush();
    expect(release).toHaveBeenCalledTimes(1);
    poll.resolve(status("countdown")); await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(store.getState().desiredEnabled).toBe(false);
  });
  it("fails closed without issuing a shutdown poll when acquiring the hold fails", async () => {
    const hold = vi.fn(() => { throw new Error("submission barrier unavailable"); });
    const { native, store } = setup({ ...status("countdown"), remainingSeconds: 0 }, hold); await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(native.mock.calls.some(([command]) => command === "task_shutdown_poll")).toBe(false);
    expect(native).toHaveBeenLastCalledWith("task_shutdown_set", { enabled: false });
    expect(store.getState().status).toMatchObject({ phase: "failed", error: "submission barrier unavailable" });
    expect(store.getState().desiredEnabled).toBe(false);
  });
  it("does not invoke native commands on web or advance requested/unsupported states", async () => {
    const native = vi.fn(); const web = createTaskShutdownStore({ invoke: native, readBusy: () => false, web: true });
    web.getState().start(); await web.getState().setEnabled(true); web.getState().dispose();
    expect(native).not.toHaveBeenCalled();
    const requested = setup(status("requested")); const unsupported = setup({ ...status(), supported: false }); await flush();
    await unsupported.store.getState().setEnabled(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requested.native).toHaveBeenCalledTimes(1); expect(unsupported.native).toHaveBeenCalledTimes(1);
  });
});
