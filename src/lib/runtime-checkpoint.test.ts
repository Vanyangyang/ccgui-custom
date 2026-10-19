import { describe, expect, it, vi } from "vitest";
import { cloneCheckpointValue, createRuntimeCheckpointCoordinator } from "./runtime-checkpoint";

describe("runtime checkpoint barrier", () => {
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
