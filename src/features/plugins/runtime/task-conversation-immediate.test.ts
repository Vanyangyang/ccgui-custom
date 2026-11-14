import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import type { HostTaskFacade } from "./task-facade";
import type { HostTaskMessageRequest } from "@ccgui/plugin-sdk";

const KEY = "__host_tasks_v1:conversations";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function fixture(saved = new Map<string, unknown>()) {
  const ref = { engine: "claude", sessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/owned" };
  const state = { messages: [], status: "busy" as "busy" | "idle" | "awaiting_permission", runId: "parent-run" as string | null, canDeliver: false, readyForQueuedInput: false };
  const controls = { paused: false, blocked: false, proven: true, otherSession: false };
  const proofs = new Map<string, { status: "completed" | "cancelled" }>();
  const branches: Awaited<ReturnType<HostTaskFacade["leaderBranches"]>> = [];
  let run = 0, notify = () => {};
  const policy = { version: "v1", text: "original instructions" };
  const facade = {
    ready: async () => {}, fixedInstructionsSupported: async () => true,
    openBackground: vi.fn(async () => {}), conversationState: () => state,
    leaderBranches: vi.fn(async () => branches), subscribe: (callback: () => void) => { notify = callback; return () => {}; },
    listen: async () => () => {}, settledRun: (id: string) => proofs.get(id) ?? null, liveRun: (id: string) => state.runId === id ? "owned-key" : null,
    prepareImmediateMessage: vi.fn(async (_ref: unknown, _runId: string | null) => {}),
    interrupt: vi.fn(async () => true), stopChild: vi.fn(async () => {}),
    continueMessage: vi.fn(async (...args: Parameters<NonNullable<HostTaskFacade["continueMessage"]>>): Promise<{ delivery: "turn" | "steer" | "live"; runId: string }> => {
      const [, , , runId, fence] = args;
      await fence("turn", runId);
      state.runId = runId; state.status = "busy"; state.canDeliver = false;
      return { delivery: "turn" as const, runId };
    }),
  };
  const storage = {
    get: vi.fn(async (_plugin: string, key: string) => structuredClone(saved.get(key))),
    set: vi.fn(async (_plugin: string, key: string, value: unknown) => { saved.set(key, structuredClone(value)); }),
    delete: vi.fn(async () => {}),
  };
  const deps = { pluginId: "immediate-test", storage,
    owned: vi.fn(async (id: string) => {
      if (id !== "root") throw new Error("Not an owned coordinator");
      return { proven: controls.proven, fixedInstructions: policy, receipt: { requestId: id, status: "completed", workspacePath: ref.workspacePath,
        session: controls.otherSession ? { ...ref, sessionId: "22222222-2222-2222-2222-222222222222" } : ref } };
    }),
    facade: async () => facade, resolveImages: vi.fn(async (ids: string[]) => ids.map(id => `resolved:${id}`)),
    verify: vi.fn(async () => {}), blocked: () => controls.blocked, paused: () => controls.paused,
    hold: vi.fn(), runId: () => `input-run-${++run}`, now: () => 100,
  };
  const bridge = createTaskConversationBridge(deps as never); disposers.push(bridge.dispose);
  const enqueue = async (count = 2, extra: Partial<HostTaskMessageRequest> = {}) => {
    for (let index = 1; index <= count; index++) await bridge.sendMessage({ conversationRequestId: "root", requestId: `input-${index}`,
      expectedInputRevision: index - 1, prompt: `prompt-${index} 中文🌏`, displayText: `display-${index}`, images: [`image-${index}`], ...extra });
    await bridge.drain();
  };
  return { bridge, saved, storage, deps, facade, state, controls, ref, proofs, branches, policy, enqueue, notify: () => notify() };
}

describe("explicit coordinator queue policy", () => {
  const request = { conversationRequestId: "root", requestId: "input-1", expectedInputRevision: 0, prompt: "continue", deliveryMode: "queue" as const };
  const idle = (f: ReturnType<typeof fixture>) => { f.state.status = "idle"; f.state.runId = null; f.state.canDeliver = true; };
  const steerable = (f: ReturnType<typeof fixture>) => {
    f.ref.engine = "codex"; f.state.canDeliver = true;
    f.facade.continueMessage.mockImplementation(async (...args) => {
      const runId = f.state.runId!; await args[4]("steer", runId); return { delivery: "steer", runId };
    });
  };

  it.each([undefined, "queue"] as const)("delivers %s with only an active child without stopping it", async deliveryMode => {
    const f = fixture(); idle(f);
    f.branches.push({ id: "child", parentEngine: f.ref.engine, parentSessionId: f.ref.sessionId, parentWorkspacePath: f.ref.workspacePath,
      engine: "codex", sessionId: "child-session", workspacePath: f.ref.workspacePath, state: "running", title: "working child" } as never);
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "running", nativeStatus: "idle", canSend: true });
    await f.bridge.sendMessage({ ...request, deliveryMode }); await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "received", delivery: "turn" });
    expect(f.facade.continueMessage).toHaveBeenCalledOnce();
    expect(f.facade.stopChild).not.toHaveBeenCalled(); expect(f.facade.interrupt).not.toHaveBeenCalled();
    expect(f.branches[0].state).toBe("running");
  });

  it("waits despite Codex steer support and starts a turn only after native idle", async () => {
    const f = fixture(); f.ref.engine = "codex"; f.state.canDeliver = true;
    expect(await f.bridge.sendMessage(request)).toMatchObject({ status: "queued", deliveryMode: "queue" });
    await f.bridge.drain(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(await f.bridge.conversation("root")).toMatchObject({ nativeStatus: "busy", canSend: true });
    idle(f); f.notify(); await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "received", delivery: "turn", deliveryMode: "queue" });
    expect(f.facade.continueMessage).toHaveBeenCalledOnce();
  });

  it("retains automatic steer behavior when the policy is omitted", async () => {
    const f = fixture(); steerable(f);
    await f.bridge.sendMessage({ ...request, deliveryMode: undefined }); await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "received", delivery: "steer" });
  });

  it("delivers queued input when a Claude reply finishes while background tasks keep its process alive", async () => {
    const f = fixture(); f.state.canDeliver = true;
    f.facade.continueMessage.mockImplementation(async (...args) => {
      await args[4]("live", "parent-run"); return { delivery: "live", runId: "parent-run" };
    });
    await f.bridge.sendMessage(request); await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    f.state.readyForQueuedInput = true; f.notify(); await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "received", delivery: "live", deliveryMode: "queue" });
    expect(await f.bridge.conversation("root")).toMatchObject({ nativeStatus: "busy", nativeReplyIdle: true });
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled(); expect(f.facade.stopChild).not.toHaveBeenCalled();
  });

  it("keeps a queue request when the idle Claude reply becomes active before live delivery", async () => {
    const f = fixture(); f.state.canDeliver = true; f.state.readyForQueuedInput = true;
    f.facade.continueMessage.mockImplementation(async (...args) => {
      f.state.readyForQueuedInput = false; await args[4]("live", "parent-run"); return { delivery: "live", runId: "parent-run" };
    });
    await f.bridge.sendMessage(request); await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue" });
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it("allows explicit send-now to override only the selected queued policy", async () => {
    const f = fixture(); steerable(f); await f.enqueue(2, { deliveryMode: "queue" });
    const fingerprints = f.bridge.capture().records[0].inputs.map(i => i.fingerprint);
    await f.bridge.sendMessageNow("root", "input-2", 2); await f.bridge.drain();
    expect(f.facade.prepareImmediateMessage).toHaveBeenCalledExactlyOnceWith(f.ref, "parent-run");
    expect(f.facade.continueMessage.mock.calls.map(call => call[1])).toEqual(["prompt-2 中文🌏"]);
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue" });
    expect(await f.bridge.messageReceipt("root", "input-2")).toMatchObject({ status: "received", delivery: "steer", deliveryMode: "queue" });
    expect(f.bridge.capture().records[0].inputs.map(i => i.fingerprint)).toEqual(fingerprints);
    expect(f.facade.stopChild).not.toHaveBeenCalled(); expect(f.facade.interrupt).not.toHaveBeenCalled();
  });

  it.each([undefined, "queue"] as const)("fingerprints %s and rejects reusing the request id with the other policy", async deliveryMode => {
    const f = fixture(), input = { ...request, deliveryMode };
    const first = await f.bridge.sendMessage(input);
    expect(await f.bridge.sendMessage(input)).toEqual(first);
    await expect(f.bridge.sendMessage({ ...request, deliveryMode: deliveryMode ? undefined : "queue" })).rejects.toThrow(/fingerprint/);
    expect(f.bridge.capture().records[0].inputs).toHaveLength(1);
  });

  it("keeps the strict wait when native immediate preparation fails", async () => {
    const f = fixture(); steerable(f); await f.bridge.sendMessage(request); await f.bridge.drain();
    f.facade.prepareImmediateMessage.mockRejectedValueOnce(new Error("native preparation unavailable"));
    await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow("native preparation unavailable");
    await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue" });
    expect(f.bridge.capture().records[0].prioritizedInput).toBeUndefined();
  });

  it.each(["paused", "blocked", "unknown", "fixed-instructions", "tier", "cost", "stop", "permission"] as const)("send-now preserves the %s boundary for a strict queue request", async reason => {
    const f = fixture(); steerable(f);
    Object.assign(f.facade, { codexServiceTierOverrideSupported: async () => true });
    await f.bridge.sendMessage({ ...request,
      ...(reason === "fixed-instructions" ? { fixedInstructions: { version: "v2", text: "changed instructions" } } : {}),
      ...(reason === "tier" ? { codexServiceTier: "priority" as const } : {}) });
    await f.bridge.drain();
    if (reason === "paused") f.controls.paused = true;
    if (reason === "blocked") f.controls.blocked = true;
    if (reason === "unknown") {
      const cut = f.bridge.capture(); cut.records[0].ownershipError = "Owner cannot be proven"; f.bridge.restore(cut);
    }
    if (reason === "cost") {
      idle(f);
      Object.assign(f.facade, { sessionCostReview: () => ({ required: true, signature: "cost-review", review: {
        model: "codex", cacheHeat: "cold", usageKind: "unknown", capturedAt: 100,
      } }) });
    }
    if (reason === "stop") await f.bridge.stopConversation("root");
    if (reason === "permission") {
      f.state.status = "awaiting_permission"; f.state.canDeliver = false;
      f.facade.prepareImmediateMessage.mockRejectedValueOnce(new Error("pending native approval"));
    }
    if (reason === "stop") expect(await f.bridge.sendMessageNow("root", "input-1", 1)).toMatchObject({ status: "cancelled" });
    else await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow();
    await f.bridge.drain(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    if (reason !== "permission") expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it.each(["agy", "cursor"])("does not manufacture immediate native support for %s", async engine => {
    const f = fixture(); f.ref.engine = engine;
    await f.bridge.sendMessage(request); await f.bridge.drain();
    f.facade.prepareImmediateMessage.mockRejectedValueOnce(new Error("engine does not support immediate delivery"));
    await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow("engine does not support immediate delivery");
    await f.bridge.drain(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue" });
  });

  it.each([null, "auto", "immediate", "", false, {}])("rejects invalid deliveryMode %j before acceptance", async deliveryMode => {
    const f = fixture();
    await expect(f.bridge.sendMessage({ ...request, deliveryMode } as never)).rejects.toThrow("Invalid continuation request");
    expect(f.bridge.capture().records).toHaveLength(0); expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, "queue"] as const)("restores %s policy without changing legacy fingerprints", async deliveryMode => {
    const f = fixture(); f.ref.engine = "codex";
    await f.bridge.sendMessage({ ...request, deliveryMode }); await f.bridge.drain();
    const input = f.bridge.capture().records[0].inputs[0];
    if (deliveryMode === undefined) expect(input.fingerprint).toBe(JSON.stringify(["root", "input-1", 0, "continue", []]));
    f.bridge.dispose(); const cold = fixture(f.saved); steerable(cold);
    await cold.bridge.ready(); await cold.bridge.drain();
    expect(cold.bridge.capture().records[0].inputs[0].fingerprint).toBe(input.fingerprint);
    if (deliveryMode) {
      expect(cold.facade.continueMessage).not.toHaveBeenCalled();
      expect(await cold.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue" });
      idle(cold); cold.facade.continueMessage.mockImplementation(async (...args) => { await args[4]("turn", args[3]); return { delivery: "turn", runId: args[3] }; });
      await cold.bridge.drain(); expect(cold.facade.continueMessage).toHaveBeenCalledOnce();
    } else expect(await cold.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "received", delivery: "steer" });
    expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it("restores explicit send-now priority for a strict queued receipt without repeating native preparation", async () => {
    const f = fixture(); f.ref.engine = "codex";
    await f.bridge.sendMessage(request); await f.bridge.drain();
    await f.bridge.sendMessageNow("root", "input-1", 1); await f.bridge.drain();
    const fingerprint = f.bridge.capture().records[0].inputs[0].fingerprint;
    f.bridge.dispose(); const cold = fixture(f.saved); steerable(cold);
    await cold.bridge.ready(); await cold.bridge.drain();
    expect(await cold.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "received", delivery: "steer", deliveryMode: "queue" });
    expect(cold.facade.continueMessage).toHaveBeenCalledOnce(); expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
    expect(cold.bridge.capture().records[0].inputs[0].fingerprint).toBe(fingerprint);
  });

  it("does not replay a strict input after an ambiguous native delivery failure", async () => {
    const f = fixture(); idle(f);
    f.facade.continueMessage.mockImplementation(async (...args) => { await args[4]("turn", args[3]); throw new Error("acknowledgement lost"); });
    await f.bridge.sendMessage(request); await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "unknown", deliveryMode: "queue" });
    expect(f.facade.continueMessage).toHaveBeenCalledOnce();
    f.bridge.dispose(); const cold = fixture(f.saved); idle(cold); await cold.bridge.ready(); await cold.bridge.drain();
    expect(await cold.bridge.sendMessageNow("root", "input-1", 1)).toMatchObject({ status: "unknown", deliveryMode: "queue" });
    expect(cold.facade.continueMessage).not.toHaveBeenCalled(); expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it.each(["input-invalid", "receipt-invalid", "input-missing", "receipt-missing", "fingerprint"])("rejects %s policy corruption on restore", async kind => {
    const f = fixture(); await f.bridge.sendMessage(request); await f.bridge.drain();
    const cut = f.bridge.capture(), input = cut.records[0].inputs[0];
    if (kind === "input-invalid") Object.assign(input, { deliveryMode: "auto" });
    if (kind === "receipt-invalid") Object.assign(input.receipt, { deliveryMode: "auto" });
    if (kind === "input-missing") delete input.deliveryMode;
    if (kind === "receipt-missing") delete input.receipt.deliveryMode;
    if (kind === "fingerprint") { delete input.deliveryMode; delete input.receipt.deliveryMode; }
    expect(() => f.bridge.restore(cut)).toThrow("Invalid conversation input fence");
  });

  it.each(["cancelled", "unknown", "starting"] as const)("never replays a restored %s strict queued input", async status => {
    const f = fixture(); await f.bridge.sendMessage(request); await f.bridge.drain();
    if (status === "cancelled") await f.bridge.cancelMessage("root", "input-1");
    else {
      const cut = f.bridge.capture(); cut.records[0].inputs[0].receipt.status = status;
      cut.records[0].inputs[0].receipt.runId = "uncertain-run";
      f.bridge.restore(cut); await f.bridge.conversation("root");
    }
    f.bridge.dispose(); const cold = fixture(f.saved); idle(cold); await cold.bridge.ready(); await cold.bridge.drain();
    expect(await cold.bridge.sendMessageNow("root", "input-1", 1)).toMatchObject({ status: status === "starting" ? "unknown" : status, deliveryMode: "queue" });
    expect(cold.facade.continueMessage).not.toHaveBeenCalled(); expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it.each(["turn", "steer", "live"] as const)("fences idle-to-busy races before native %s delivery", async delivery => {
    const f = fixture(); await f.bridge.sendMessage(request); await f.bridge.drain();
    const delivered = vi.fn(); idle(f);
    f.facade.continueMessage.mockImplementation(async (...args) => {
      f.state.status = "busy"; f.state.canDeliver = true; f.state.runId = "racing-run";
      await args[4](delivery, delivery === "turn" ? args[3] : "racing-run"); delivered();
      return { delivery, runId: args[3] };
    });
    await f.bridge.drain();
    expect(f.facade.continueMessage).toHaveBeenCalledOnce(); expect(delivered).not.toHaveBeenCalled();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue", error: expect.stringContaining("idle coordinator") });
  });

  it.each(["verify", "persist"] as const)("rechecks strict idle after the awaited %s delivery fence", async boundary => {
    const f = fixture(); await f.bridge.sendMessage(request); await f.bridge.drain(); idle(f);
    const busy = () => { f.state.status = "busy"; f.state.runId = "racing-run"; f.state.canDeliver = true; };
    if (boundary === "verify") f.deps.verify.mockImplementationOnce(async () => busy());
    else {
      const save = f.storage.set.getMockImplementation()!;
      f.storage.set.mockImplementation(async (...args) => {
        await save(...args);
        if ((args[2] as any).records[0].inputs[0].receipt.status === "starting") busy();
      });
    }
    const delivered = vi.fn();
    f.facade.continueMessage.mockImplementation(async (...args) => { await args[4]("turn", args[3]); delivered(); return { delivery: "turn", runId: args[3] }; });
    await f.bridge.drain(); expect(delivered).not.toHaveBeenCalled();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", deliveryMode: "queue" });
  });
});

describe("persistent queued message immediate delivery", () => {
  it("prioritizes the selected second input without changing chronological identity or creating another input", async () => {
    const f = fixture(); await f.enqueue();
    const original = f.bridge.capture().records[0].inputs.map(input => ({ fingerprint: input.fingerprint, prompt: input.prompt, receipt: input.receipt }));
    f.facade.prepareImmediateMessage.mockImplementationOnce(async (ref, runId) => {
      expect(ref).toEqual(f.ref); expect(runId).toBe("parent-run");
      expect((f.saved.get(KEY) as any).records[0].prioritizedInput).toBe("input-2");
      expect(f.facade.continueMessage).not.toHaveBeenCalled();
    });
    expect(await f.bridge.sendMessageNow("root", "input-2", 2)).toMatchObject({ requestId: "input-2", inputRevision: 2, status: "queued", sendNowRequested: true });
    await f.bridge.drain(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.capture().records[0].inputs.map(input => ({ fingerprint: input.fingerprint, prompt: input.prompt, receipt: input.receipt }))).toEqual(original);
    f.state.status = "idle"; f.state.canDeliver = true; f.state.runId = null;
    await f.bridge.drain();
    expect(f.facade.continueMessage.mock.calls.map(call => call[1])).toEqual(["prompt-2 中文🌏"]);
    expect(f.facade.continueMessage.mock.calls[0][2]).toEqual(["resolved:image-2"]);
    expect(await f.bridge.messageReceipt("root", "input-2")).toMatchObject({ requestId: "input-2", inputRevision: 2, status: "received" });
    expect(await f.bridge.messageReceipt("root", "input-2")).not.toHaveProperty("sendNowRequested");
    f.proofs.set("input-run-1", { status: "completed" }); f.state.status = "idle"; f.state.canDeliver = true; f.state.runId = null;
    await f.bridge.drain();
    expect(f.facade.continueMessage.mock.calls.map(call => call[1])).toEqual(["prompt-2 中文🌏", "prompt-1 中文🌏"]);
    const record = f.bridge.capture().records[0];
    expect(record.inputs.map(input => input.receipt.requestId)).toEqual(["input-1", "input-2"]);
    expect(record.inputRevision).toBe(2);
    await f.bridge.sendMessageNow("root", "input-2", 2);
    expect(f.facade.prepareImmediateMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a pending immediate flight and blocks pump until native preparation settles", async () => {
    const f = fixture(); await f.enqueue(); const gate = deferred<void>();
    f.facade.prepareImmediateMessage.mockImplementationOnce(async () => gate.promise);
    const first = f.bridge.sendMessageNow("root", "input-2", 2);
    await vi.waitFor(() => expect(f.facade.prepareImmediateMessage).toHaveBeenCalledOnce());
    expect(f.bridge.pendingImmediate()).toBe(true);
    const duplicate = f.bridge.sendMessageNow("root", "input-2", 2);
    await expect(f.bridge.sendMessageNow("root", "input-2", 1)).rejects.toThrow(/pending|revision/);
    await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow(/pending/);
    f.state.status = "idle"; f.state.canDeliver = true; f.state.runId = null;
    await f.bridge.drain(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    gate.resolve(); expect(await first).toMatchObject({ status: "queued", requestId: "input-2" });
    expect(await duplicate).toMatchObject({ requestId: "input-2" });
    expect(f.facade.prepareImmediateMessage).toHaveBeenCalledOnce(); expect(f.bridge.pendingImmediate()).toBe(false);
    await f.bridge.drain(); expect(f.facade.continueMessage.mock.calls[0][1]).toBe("prompt-2 中文🌏");
  });

  it.each([
    ["cancel", undefined], ["stop", undefined], ["cancel", "queue"], ["stop", "queue"],
  ] as const)("lets %s finish during deferred native preparation with %s policy and never delivers the abandoned input", async (action, deliveryMode) => {
    const f = fixture(); await f.enqueue(1, { deliveryMode }); const gate = deferred<void>();
    f.facade.prepareImmediateMessage.mockImplementationOnce(async () => gate.promise);
    const preparing = f.bridge.sendMessageNow("root", "input-1", 1);
    await vi.waitFor(() => expect(f.facade.prepareImmediateMessage).toHaveBeenCalledOnce());
    if (action === "cancel") expect(await f.bridge.cancelMessage("root", "input-1")).toMatchObject({ status: "cancelled" });
    else expect(await f.bridge.stopConversation("root")).toMatchObject({ stopRequested: true });
    expect(f.bridge.pendingImmediate()).toBe(true);
    expect(f.bridge.capture().records[0].prioritizedInput).toBeUndefined();
    gate.resolve(); expect(await preparing).toMatchObject({ status: "cancelled" });
    f.state.status = "idle"; f.state.canDeliver = true; f.state.runId = null;
    f.proofs.set("parent-run", { status: "cancelled" }); await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });

  it("retains a failed immediate preparation as the same queued message and allows an explicit retry", async () => {
    const f = fixture(); await f.enqueue(1);
    const fingerprint = f.bridge.capture().records[0].inputs[0].fingerprint;
    f.facade.prepareImmediateMessage.mockRejectedValueOnce(new Error("stdin timed out"));
    await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow("stdin timed out");
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued", error: "stdin timed out" });
    expect(f.bridge.capture().records[0].prioritizedInput).toBeUndefined();
    expect(await f.bridge.sendMessageNow("root", "input-1", 1)).toMatchObject({ status: "queued", sendNowRequested: true });
    expect(f.facade.prepareImmediateMessage).toHaveBeenCalledTimes(2);
    expect(f.bridge.capture().records[0].inputs).toHaveLength(1);
    expect(f.bridge.capture().records[0].inputs[0].fingerprint).toBe(fingerprint);
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });

  it.each(["paused", "blocked", "unknown", "fixed-instructions", "stale-revision"] as const)("does not interrupt or deliver across the %s gate", async reason => {
    const f = fixture();
    await f.enqueue(2, reason === "fixed-instructions" ? { fixedInstructions: { version: "v2", text: "changed instructions" } } : {});
    if (reason === "paused") f.controls.paused = true;
    if (reason === "blocked") f.controls.blocked = true;
    if (reason === "unknown") { const cut = f.bridge.capture(); cut.records[0].inputs[0].receipt.status = "unknown"; f.bridge.restore(cut); }
    await expect(f.bridge.sendMessageNow("root", "input-2", reason === "stale-revision" ? 1 : 2)).rejects.toThrow();
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.capture().records[0].inputs).toHaveLength(2);
  });

  it("keeps an open permission card queued when native preparation rejects it", async () => {
    const f = fixture(); await f.enqueue(1); f.state.status = "awaiting_permission";
    f.facade.prepareImmediateMessage.mockRejectedValueOnce(new Error("pending native approval"));
    await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow("pending native approval");
    await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "queued" });
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });

  it("does not bypass a permission wait after a successful preparation ACK", async () => {
    const f = fixture(); await f.enqueue(1); f.state.status = "awaiting_permission";
    expect(await f.bridge.sendMessageNow("root", "input-1", 1)).toMatchObject({ status: "queued", sendNowRequested: true });
    await f.bridge.drain(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    f.state.status = "idle"; f.state.canDeliver = true; f.state.runId = null;
    await f.bridge.drain(); expect(f.facade.continueMessage).toHaveBeenCalledOnce();
    expect(f.facade.continueMessage.mock.calls[0][1]).toBe("prompt-1 中文🌏");
  });

  it.each(["unknown", "starting", "received", "completed", "cancelled", "failed"] as const)("returns a %s original receipt without replaying native preparation", async status => {
    const f = fixture(); await f.enqueue(1);
    const cut = f.bridge.capture(); cut.records[0].inputs[0].receipt.status = status;
    if (["starting", "received", "completed"].includes(status)) cut.records[0].inputs[0].receipt.runId = "original-input-run";
    f.bridge.restore(cut);
    expect(await f.bridge.sendMessageNow("root", "input-1", 1)).toMatchObject({ requestId: "input-1", inputRevision: 1, status });
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.capture().records[0].inputs).toHaveLength(1);
  });

  it("restores persisted priority but never automatically reissues native immediate preparation", async () => {
    const f = fixture(); await f.enqueue(); await f.bridge.sendMessageNow("root", "input-2", 2); await f.bridge.drain(); f.bridge.dispose();
    const cold = fixture(f.saved); await cold.bridge.ready(); await cold.bridge.drain();
    expect(await cold.bridge.messageReceipt("root", "input-2")).toMatchObject({ status: "queued", sendNowRequested: true });
    expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled(); expect(cold.facade.continueMessage).not.toHaveBeenCalled();
    cold.state.status = "idle"; cold.state.runId = null; cold.state.canDeliver = true; await cold.bridge.drain();
    expect(cold.facade.continueMessage.mock.calls.map(call => call[1])).toEqual(["prompt-2 中文🌏"]);
    expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it("does not issue native preparation when the priority intent cannot be persisted", async () => {
    const f = fixture(); await f.enqueue(1); f.storage.set.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(f.bridge.sendMessageNow("root", "input-1", 1)).rejects.toThrow(/persistence/);
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled(); expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.pendingImmediate()).toBe(false);
    expect(f.bridge.capture().records[0].inputs[0].receipt.status).toBe("unknown");
    expect(f.bridge.capture().records[0].prioritizedInput).toBeUndefined();
  });

  it("fences changed native ownership without persisting an invalid nonqueued priority", async () => {
    const f = fixture(); await f.enqueue(1); const gate = deferred<void>();
    f.facade.prepareImmediateMessage.mockImplementationOnce(async () => gate.promise);
    const preparing = f.bridge.sendMessageNow("root", "input-1", 1);
    const rejected = expect(preparing).rejects.toThrow(/identity/);
    await vi.waitFor(() => expect(f.facade.prepareImmediateMessage).toHaveBeenCalledOnce());
    f.controls.otherSession = true; gate.resolve(); await rejected;
    const cut = f.bridge.capture().records[0];
    expect(cut.inputs[0].receipt.status).toBe("unknown"); expect(cut.prioritizedInput).toBeUndefined();
    f.bridge.dispose(); const cold = fixture(f.saved); await expect(cold.bridge.ready()).resolves.toBeUndefined();
    expect(cold.facade.continueMessage).not.toHaveBeenCalled(); expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it("clears a failed priority before persistence so recovery can inspect the original failed input", async () => {
    const f = fixture(); await f.enqueue(1); await f.bridge.sendMessageNow("root", "input-1", 1); await f.bridge.drain();
    f.deps.resolveImages.mockRejectedValueOnce(new Error("image no longer owned"));
    f.state.status = "idle"; f.state.canDeliver = true; f.state.runId = null; await f.bridge.drain();
    expect(await f.bridge.messageReceipt("root", "input-1")).toMatchObject({ status: "failed", error: "image no longer owned" });
    expect(f.bridge.capture().records[0].prioritizedInput).toBeUndefined();
    f.bridge.dispose(); const cold = fixture(f.saved); await cold.bridge.ready();
    expect(await cold.bridge.messageReceipt("root", "input-1")).toMatchObject({ requestId: "input-1", status: "failed" });
    expect(cold.facade.prepareImmediateMessage).not.toHaveBeenCalled();
  });

  it.each(["scope", "ownership"] as const)("rechecks %s if it changes while the priority write is awaiting", async change => {
    const f = fixture(); await f.enqueue(1); const gate = deferred<void>();
    const original = f.storage.set.getMockImplementation()!;
    f.storage.set.mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
    const preparing = f.bridge.sendMessageNow("root", "input-1", 1);
    const rejected = expect(preparing).rejects.toThrow();
    await vi.waitFor(() => expect(f.bridge.capture().records[0].prioritizedInput).toBe("input-1"));
    if (change === "scope") f.controls.blocked = true; else f.controls.otherSession = true;
    gate.resolve(); await rejected;
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });

  it("rechecks ownership after the last awaited selection verification before native preparation", async () => {
    const f = fixture(); await f.enqueue(1); const gate = deferred<void>();
    f.deps.verify.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => gate.promise);
    const preparing = f.bridge.sendMessageNow("root", "input-1", 1);
    const rejected = expect(preparing).rejects.toThrow(/identity|ownership/);
    await vi.waitFor(() => expect(f.deps.verify).toHaveBeenCalledTimes(2));
    f.controls.otherSession = true; gate.resolve(); await rejected;
    expect(f.facade.prepareImmediateMessage).not.toHaveBeenCalled();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
  });
});
