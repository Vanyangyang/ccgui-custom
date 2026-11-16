import { describe, expect, it, vi } from "vitest";
import { cloneCheckpointValue, createRuntimeCheckpointCoordinator } from "./runtime-checkpoint";

describe("runtime checkpoint barrier", () => {
  it("separates idle UI capture blockers from activity while sharing the hold predicate", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize(undefined, { requiredParticipants: [] });
    let transitioning = false;
    coordinator.registerBlocker("window", () => ["plugin-window-without-checkpoint"], () => transitioning ? ["plugin-window-transition"] : []);
    coordinator.registerBlocker("draft", () => ["unsaved-git-commit-message"], () => []);
    expect(coordinator.activityReadiness()).toEqual([]);
    coordinator.holdSubmissions()();
    expect(coordinator.readiness(false)).toHaveLength(2);
    await expect(coordinator.prepare()).rejects.toThrow(/plugin-window-without-checkpoint.*unsaved-git-commit-message/);
    coordinator.abort();
    transitioning = true;
    expect(coordinator.activityReadiness()).toEqual([{ participant: "window", reason: "plugin-window-transition" }]);
    expect(() => coordinator.holdSubmissions()).toThrow(/plugin-window-transition/);
  });

  it("retains required/restoring participants, ordinary readiness and operations in activity checks", () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({ version: 1, participants: { chat: {}, late: {} } }, { requiredParticipants: ["chat"] });
    coordinator.abort();
    expect(coordinator.activityReadiness()).toEqual(expect.arrayContaining([
      { participant: "chat", reason: "participant-unavailable" }, { participant: "late", reason: "checkpoint-not-restored" },
    ]));
    coordinator.register({ id: "chat", capture: () => ({}), restore() {}, readiness: () => ["queue-pending"], captureReadiness: () => ["open-dialog"] });
    coordinator.registerBlocker("legacy", () => ["legacy-operation"]);
    coordinator.beginOperation("send-awaiting-ack");
    expect(coordinator.activityReadiness()).toEqual(expect.arrayContaining([
      { participant: "chat", reason: "queue-pending" }, { participant: "legacy", reason: "legacy-operation" }, { participant: "operation", reason: "send-awaiting-ack" },
    ]));
    expect(coordinator.activityReadiness().some(blocker => blocker.reason === "open-dialog")).toBe(false);
    expect(() => coordinator.holdSubmissions()).toThrow(/queue-pending/);
  });
  it("holds final shutdown admission without capturing popovers and only its owner can release it", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize(undefined, { requiredParticipants: ["chat"] });
    const capture = vi.fn(() => ({}));
    coordinator.register({ id: "chat", capture, restore: () => {}, captureReadiness: () => ["open-dialog"] });
    const release = coordinator.holdSubmissions();
    expect(coordinator.isPaused()).toBe(true);
    expect(() => coordinator.beginOperation("send")).toThrow(/paused/);
    await expect(coordinator.prepare()).rejects.toThrow(/pending system action/);
    coordinator.abort(); coordinator.resumeCommitted(); await coordinator.resume();
    expect(coordinator.isPaused()).toBe(true);
    const resumed = vi.fn();
    const waiting = coordinator.whenResumed().then(resumed);
    expect(capture).not.toHaveBeenCalled();
    release(); release(); await waiting;
    expect(resumed).toHaveBeenCalledOnce();
    expect(coordinator.isPaused()).toBe(false);
    coordinator.beginOperation("new send")();
  });

  it("cannot take a shutdown hold over an in-flight operation or an update pause", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize(undefined, { requiredParticipants: [] });
    const done = coordinator.beginOperation("send-before-native-ack");
    expect(() => coordinator.holdSubmissions()).toThrow(/send-before-native-ack/);
    expect(coordinator.isPaused()).toBe(false);
    done();
    await coordinator.prepare();
    expect(() => coordinator.holdSubmissions()).toThrow(/already paused/);
    coordinator.abort();
    coordinator.holdSubmissions()();
  });

  it("waits for restoration ownership without changing readiness revisions", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({ version: 1, participants: { chat: {} } }, { requiredParticipants: ["chat"] });
    coordinator.register({ id: "chat", capture: () => ({}), restore: () => {} });
    const readiness = coordinator.awaitReady();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const ready = vi.fn();
    const waiting = coordinator.whenResumed(controller.signal).then(ready);
    await readiness;
    expect(ready).not.toHaveBeenCalled();
    expect(coordinator.isPaused()).toBe(true);
    await coordinator.resume(); await waiting;
    expect(ready).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(coordinator.isPaused()).toBe(false);
  });

  it("rejects cancelled readiness waits and removes their abort listeners", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({ version: 1, participants: {} }, { requiredParticipants: [] });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = coordinator.whenResumed(controller.signal);
    controller.abort(new Error("plugin unloaded"));
    await expect(pending).rejects.toThrow("plugin unloaded");
    expect(remove).toHaveBeenCalledOnce();
    coordinator.abort();
    expect(remove).toHaveBeenCalledOnce();
    await expect(coordinator.whenResumed(controller.signal)).rejects.toThrow("plugin unloaded");
  });

  it.each(["abort", "resumeCommitted", "resume"] as const)("releases waiters on %s even when participant resume throws", async (method) => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({ version: 1, participants: { chat: {} } }, { requiredParticipants: ["chat"] });
    coordinator.register({ id: "chat", capture: () => ({}), restore: () => {}, resumed() { throw new Error("participant failed"); } });
    const waiting = coordinator.whenResumed();
    await expect(Promise.resolve().then(() => coordinator[method]())).rejects.toThrow("Runtime participant resume failed");
    await expect(waiting).resolves.toBeUndefined();
    expect(coordinator.isPaused()).toBe(false);
  });

  it("resolves unpaused waits without listeners or invalidating an in-flight preparation", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize(undefined, { requiredParticipants: [] });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    await expect(coordinator.whenResumed(controller.signal)).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    const preparing = coordinator.prepare();
    const waiting = coordinator.whenResumed();
    await expect(preparing).resolves.toEqual({ version: 1, participants: {} });
    coordinator.abort(); await waiting;
  });
  it("keeps capture-only blockers out of restore readiness while retaining real recovery blockers", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({ version: 1, participants: { chat: {}, "app-ui": {} } });
    let blockers = ["ledger-not-restored"];
    const capture = vi.fn(() => ({}));
    coordinator.register({ id: "chat", capture, restore: () => {}, readiness: () => blockers });
    coordinator.register({ id: "app-ui", capture, restore: () => {}, captureReadiness: () => ["open-dialog"] });
    await expect(coordinator.awaitReady()).rejects.toThrow(/ledger-not-restored/);
    blockers = [];
    await coordinator.awaitReady();
    expect(coordinator.isPaused()).toBe(true);
    await expect(coordinator.prepare()).rejects.toThrow(/open-dialog/);
    expect(capture).not.toHaveBeenCalled();
  });
  it("freezes synchronously and restores late participants before they are exposed", async () => {
    const old = createRuntimeCheckpointCoordinator();
    old.initialize(undefined, { requiredParticipants: ["chat"] });
    const data = { text: "中文🙂", queue: ["one"] };
    old.register({ id: "chat", capture: () => data, restore: () => {} });
    const pending = old.prepare();
    expect(old.isPaused()).toBe(true);
    expect(() => old.beginOperation("send")).toThrow(/paused/);
    const checkpoint = await pending;
    data.queue.push("after-cut");
    expect(checkpoint.participants.chat).toEqual({ text: "中文🙂", queue: ["one"] });
    const next = createRuntimeCheckpointCoordinator();
    next.initialize(checkpoint, { requiredParticipants: ["chat"] });
    let restored: unknown;
    let ready!: () => void;
    const subscribed = new Promise<void>((resolve) => { ready = resolve; });
    const resumed = vi.fn();
    next.register({ id: "chat", capture: () => ({}), restore: (value) => { restored = value; }, ready: () => subscribed, resumed });
    expect(restored).toEqual(checkpoint.participants.chat);
    const resume = next.resume();
    await Promise.resolve();
    expect(next.isPaused()).toBe(true);
    expect(resumed).not.toHaveBeenCalled();
    ready(); await resume;
    expect(next.isPaused()).toBe(false);
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it("does not capture an in-flight mutation or silently accept uncovered UI", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    const capture = vi.fn(() => ({}));
    coordinator.register({ id: "chat", capture, restore: () => {} });
    expect(coordinator.readiness()).toContainEqual({ participant: "app-ui", reason: "participant-unavailable" });
    const done = coordinator.beginOperation("native-send-ack-pending");
    await expect(coordinator.prepare()).rejects.toThrow(/native-send-ack-pending/);
    expect(capture).not.toHaveBeenCalled();
    done(); coordinator.abort();
    expect(coordinator.isPaused()).toBe(false);
  });

  it("abort invalidates preparation even if a late listener becomes ready", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize(undefined, { requiredParticipants: ["chat"] });
    let ready!: () => void;
    const capture = vi.fn(() => ({}));
    coordinator.register({ id: "chat", capture, restore: () => {}, ready: () => new Promise<void>((resolve) => { ready = resolve; }) });
    const preparing = coordinator.prepare();
    coordinator.abort(); ready();
    await expect(preparing).rejects.toThrow(/aborted/);
    expect(capture).not.toHaveBeenCalled();
  });

  it("readiness acknowledgement never admits submissions or drains the restored queue", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({ version: 1, participants: { chat: {} } }, { requiredParticipants: ["chat"] });
    const resumed = vi.fn();
    coordinator.register({ id: "chat", capture: () => ({}), restore: () => {}, resumed });
    await coordinator.awaitReady();
    expect(coordinator.isPaused()).toBe(true);
    expect(() => coordinator.beginOperation("send-before-health-commit")).toThrow(/paused/);
    expect(resumed).not.toHaveBeenCalled();
    await coordinator.resume();
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(coordinator.isPaused()).toBe(false);
  });

  it("rejects unsupported state instead of dropping it during JSON serialization", () => {
    expect(() => cloneCheckpointValue({ value: new Map() })).toThrow(/non-plain/);
    expect(() => cloneCheckpointValue({ value: Number.NaN })).toThrow(/non-JSON/);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => cloneCheckpointValue(circular)).toThrow(/cycle/);
  });

  it("committed ownership resumes once despite new transient work during the native acknowledgement", async () => {
    const coordinator = createRuntimeCheckpointCoordinator();
    coordinator.initialize({version:1,participants:{chat:{}}}, {requiredParticipants:["chat"]});
    let busy = false;
    const resumed = vi.fn();
    coordinator.register({id:"chat",capture:()=>({}),restore:()=>{},readiness:()=>busy?["usage-reread-pending"]:[],resumed});
    await coordinator.awaitReady();
    busy = true;
    coordinator.resumeCommitted(); coordinator.resumeCommitted();
    expect(coordinator.isPaused()).toBe(false);
    expect(resumed).toHaveBeenCalledTimes(1);
  });
});
