import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostChatTarget } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import { createRuntimeCheckpointCoordinator, type RuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { createHostChatBridge, type HostChatFacade, type ManagedParentDeliveryFacade } from "./chat-bridge";
import { TaskPreSpawnError } from "./task-facade";

const identity = { clientInstanceId: "managed-test", windowId: "window" };
const parent = { branchId: "branch", engine: "claude", sessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/parent" };
const target: HostChatTarget = { client: "ccgui", ...identity, ...parent, nativeSessionId: parent.sessionId, guiSessionId: parent.sessionId };
const id = (n: number) => `cross:${String(n).repeat(64)}`;
const caller = { ...parent, runId: "run-parent" };
const fixtures: Array<{ bridge: ReturnType<typeof createHostChatBridge> }> = [];
function fixture(snapshot?: RuntimeCheckpoint, enabled = true) {
  const checkpoint = createRuntimeCheckpointCoordinator(); checkpoint.initialize(snapshot, { requiredParticipants: [] });
  const observers = new Set<() => void>(); let events: (e: EngineEventPayload[]) => void = () => {};
  const state = { status: "busy" as "idle" | "busy" | "awaiting_permission", canDeliver: true, runId: "run-parent" as string | null, stopped: false, cost: false, model: "model" };
  const data = new Map<string, unknown>();
  const storage = { get: vi.fn(async (_p: string, key: string) => data.get(key) ?? null), set: vi.fn(async (_p: string, key: string, value: unknown) => { data.set(key, structuredClone(value)); }), delete: vi.fn(async () => {}) };
  const host: HostChatFacade = { identity, current: () => ({ ...target, status: state.status }), inspect: () => ({ ...target, status: state.status }),
    model: () => state.model, requiresCostApproval: () => state.cost, wasInterrupted: () => state.stopped,
    subscribe: cb => { observers.add(cb); return () => { observers.delete(cb); }; }, send: vi.fn(async (_t, _p, runId) => ({ runId, sessionId: parent.sessionId })) };
  const facade: ManagedParentDeliveryFacade = { inspect: () => ({ ...state }), validate: vi.fn(async () => true),
    deliver: vi.fn<ManagedParentDeliveryFacade["deliver"]>(async (_target, _prompt, requested, before) => { const delivery = state.status === "idle" ? "turn" : "live"; const runId = delivery === "turn" ? requested : state.runId!; await before(delivery, runId); return { delivery, runId }; }) };
  let count = 0;
  const bridge = createHostChatBridge("managed-test", storage, { host: async () => host, ...(enabled ? { managedParent: async () => facade } : {}),
    checkpoint, runId: () => `run-question-${++count}`, listen: async cb => { events = cb; return () => {}; } });
  const f = { bridge, checkpoint, facade, host, state, storage, data,
    wake: () => observers.forEach(cb => cb()),
    emit: (kind: EngineEventPayload["kind"], data: unknown = {}, runId = "run-parent") => events([{ engine: parent.engine, sessionId: parent.sessionId, runId, seq: 1, kind, data }]),
    submit: (n = 1, cost = false) => bridge.submitCorrespondence({ requestId: id(n), target, prompt: `question ${n} 中文 👩🏽‍💻` },
      { sender: { engine: "codex", sessionId: `child-${n}`, workspacePath: "G:/child" }, requestId: `question-${n}`, managedParent: parent }, { costGuard: cost }),
    ack: (n: number, response = `answer ${n}`) => bridge.acknowledgeMessage(caller, id(n), { readRequestId: `task-run-question-${n}`, outcome: "handled", response }),
  };
  fixtures.push(f); return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.bridge.ready().catch(() => {}); f.bridge.dispose(); } });
const retrieved = async (f: ReturnType<typeof fixture>, n = 1) => vi.waitFor(async () => expect(await f.bridge.receipt(id(n))).toMatchObject({ mailbox: { phase: "retrieved" } }));

describe("managed child questions use independent explicit receipts", () => {
  it("rejects managed metadata without a host capability and mutually exclusive relations", async () => {
    const disabled = fixture(undefined, false); await expect(disabled.submit()).rejects.toThrow("host capability");
    const f = fixture();
    await expect(f.bridge.submitCorrespondence({ requestId: id(1), target, prompt: "question" }, { sender: { engine: "codex", sessionId: "child", workspacePath: "G:/child" }, requestId: "question",
      managedParent: parent, relation: { type: "reply", requestId: "other", scopedId: id(2) } })).rejects.toThrow("managed parent relation");
  });

  it("uses a tool claim for an idle parent and requires an explicit answer", async () => {
    const f = fixture(); f.state.status = "idle"; f.state.runId = null;
    const receipt = await f.submit(); await retrieved(f);
    f.emit("delta", "not an answer", receipt.runId); await f.bridge.ready();
    expect((await f.bridge.receipt(id(1)))?.text).toBeUndefined();
    await f.bridge.acknowledgeMessage({ ...caller, runId: receipt.runId }, id(1), { readRequestId: `task-${receipt.runId}`, outcome: "handled", response: "explicit answer" });
    expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "completed", text: "explicit answer" });
  });

  it.each(["error", "stop"])("marks %s without ACK uncertain", async ending => {
    const f = fixture(); await f.submit(); await retrieved(f);
    f.emit(ending === "stop" ? "turn_complete" : "error", ending === "stop" ? { interrupted: true } : "parent failed"); await f.bridge.ready();
    expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } });
  });

  it("delivers two children to one busy run ahead of ordinary FIFO and acknowledges out of order", async () => {
    const f = fixture();
    await f.bridge.submit({ requestId: "ordinary", target, prompt: "ordinary queue" });
    const first = await f.submit(1); await f.submit(2); await retrieved(f, 2);
    expect(f.host.send).not.toHaveBeenCalled(); expect(f.facade.deliver).toHaveBeenCalledTimes(2);
    const prompt = vi.mocked(f.facade.deliver).mock.calls[0][1];
    expect(prompt).toContain("question 1 中文 👩🏽‍💻"); expect(prompt).toContain(id(1)); expect(prompt).toContain("task-run-question-2");
    // The unrelated queue owns run-question-1; managed receipt stays unique.
    expect(first.runId).toBe("run-question-2");
    await f.bridge.acknowledgeMessage(caller, id(2), { readRequestId: "task-run-question-3", outcome: "handled", response: "second answer" });
    await f.bridge.acknowledgeMessage(caller, id(1), { readRequestId: "task-run-question-2", outcome: "handled", response: "first answer" });
    expect(await f.bridge.receipt(id(1))).toMatchObject({ runId: first.runId, status: "completed", text: "first answer", mailbox: { relation: "task", parentRequestId: "question-1" } });
    expect(await f.bridge.receipt(id(2))).toMatchObject({ status: "completed", text: "second answer" });
  });

  it.each([false, true])("preserves ACK before transport settles (throw=%s)", async fail => {
    const f = fixture(), gate = Promise.withResolvers<void>();
    vi.mocked(f.facade.deliver).mockImplementation(async (_t, _p, _r, before) => { await before("live", "run-parent"); await gate.promise; if (fail) throw new Error("late failure"); return { delivery: "live", runId: "run-parent" }; });
    await f.submit(); await retrieved(f); await f.ack(1); gate.resolve();
    await vi.waitFor(() => expect(f.checkpoint.isPaused()).toBe(false)); await f.bridge.ready();
    expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "completed", text: "answer 1", mailbox: { phase: "handled" } });
  });

  it("ignores old Claude turn_complete and parent output, then marks final no-ACK uncertain", async () => {
    const f = fixture(); await f.bridge.ready(); f.emit("turn_complete"); await f.bridge.ready();
    await f.submit(); await retrieved(f); f.emit("delta", "unrelated full parent output"); f.emit("turn_complete"); await f.bridge.ready();
    expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "executing", mailbox: { phase: "retrieved" } });
    await expect(f.bridge.acknowledgeMessage(caller, id(1), { readRequestId: "task-run-question-1", outcome: "handled" })).rejects.toThrow("final answer");
    f.emit("done"); await f.bridge.ready();
    expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } });
    expect((await f.bridge.receipt(id(1)))?.text).toBeUndefined();
    expect((await f.bridge.readMessages(caller, { requestId: "reconcile", messageIds: [id(1)] })).messages).toHaveLength(1);
    await f.bridge.acknowledgeMessage(caller, id(1), { readRequestId: "reconcile", outcome: "handled", response: "reconciled" });
  });

  it.each(["cost", "permission", "stop", "gate"])("holds at %s without delivery", async gate => {
    const f = fixture(); if (gate === "cost") f.state.cost = true; if (gate === "permission") f.state.status = "awaiting_permission";
    if (gate === "stop") f.state.stopped = true; if (gate === "gate") f.state.canDeliver = false;
    await f.submit(1, true); await f.bridge.ready();
    expect(f.facade.deliver).not.toHaveBeenCalled();
    await f.bridge.prioritize(id(1)); await f.bridge.ready(); expect(f.facade.deliver).not.toHaveBeenCalled();
  });

  it("cancels while transport waits before IPC and never cancels the shared run", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>();
    vi.mocked(f.facade.deliver).mockImplementation(async (_t, _p, _r, before) => { await gate.promise; await before("live", "run-parent"); return { delivery: "live", runId: "run-parent" }; });
    await f.submit(); await vi.waitFor(() => expect(f.facade.deliver).toHaveBeenCalledTimes(1));
    await f.bridge.cancel(id(1)); gate.resolve(); await f.bridge.ready();
    expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "failed" }); expect(f.state.runId).toBe("run-parent");
  });

  it.each(["permission", "cost", "model", "relationship"])("rechecks %s after durable claim before IPC", async change => {
    const f = fixture(); const write = f.storage.set.getMockImplementation()!; let changed = false;
    f.storage.set.mockImplementation(async (...args) => { await write(...args); if (!changed && (args[2] as { entries: Array<{ claim?: unknown }> }).entries.some(entry => entry.claim)) {
      changed = true;
      if (change === "permission") f.state.status = "awaiting_permission";
      if (change === "cost") f.state.cost = true;
      if (change === "model") f.state.model = "changed";
      if (change === "relationship") vi.mocked(f.facade.validate).mockResolvedValue(false);
    } });
    await f.submit(1, true);
    await vi.waitFor(() => expect(changed).toBe(true));
    await vi.waitFor(async () => expect(await f.bridge.receipt(id(1))).toMatchObject({ mailbox: { phase: "received" } }));
    await f.bridge.ready(); expect(await f.bridge.receipt(id(1))).toMatchObject({ mailbox: { phase: "received" } });
  });

  it("does not retry an unknown transport failure", async () => {
    const f = fixture(); vi.mocked(f.facade.deliver).mockImplementation(async (_t, _p, _r, before) => { await before("live", "run-parent"); throw new Error("unknown acceptance"); });
    await f.submit(); await vi.waitFor(async () => expect(await f.bridge.receipt(id(1))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } }));
    f.wake(); await f.bridge.ready(); expect(f.facade.deliver).toHaveBeenCalledTimes(1);
  });

  it("restores only a proven pre-spawn failure", async () => {
    const f = fixture(); vi.mocked(f.facade.deliver).mockRejectedValue(new TaskPreSpawnError("not delivered"));
    await f.submit(); await vi.waitFor(() => expect(f.facade.deliver).toHaveBeenCalledTimes(1)); await f.bridge.ready();
    expect(await f.bridge.receipt(id(1))).toMatchObject({ mailbox: { phase: "received" } });
  });

  it("a proven rejected child does not spin or block another child", async () => {
    const f = fixture(); vi.mocked(f.facade.deliver).mockRejectedValueOnce(new TaskPreSpawnError("not delivered"));
    await f.submit(1); await f.submit(2); await retrieved(f, 2);
    expect(f.facade.deliver).toHaveBeenCalledTimes(2);
    expect(await f.bridge.receipt(id(1))).toMatchObject({ mailbox: { phase: "received" } });
    await f.ack(2);
  });

  it("restores a checkpoint claim without redelivery and accepts its exact ACK", async () => {
    const old = fixture(); await old.submit(); await retrieved(old);
    const snapshot = await old.checkpoint.prepare(); old.bridge.dispose();
    const next = fixture(snapshot); await next.bridge.ready(); await next.checkpoint.resume();
    expect(next.facade.deliver).not.toHaveBeenCalled();
    await next.ack(1);
    expect(await next.bridge.receipt(id(1))).toMatchObject({ status: "completed", runId: "run-question-1", text: "answer 1" });
  });

  it("does not deliver while the checkpoint is paused", async () => {
    const f = fixture(); f.state.canDeliver = false; await f.submit(); await f.bridge.ready();
    await f.checkpoint.prepare(); f.state.canDeliver = true; f.wake(); await f.bridge.ready();
    expect(f.facade.deliver).not.toHaveBeenCalled();
    await f.checkpoint.resume(); await retrieved(f);
  });
});
