import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostChatTarget, HostChatSession, HostChatReceipt } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import { HostChatBusyError } from "@/features/chat/store/types";
import { createHostChatBridge, desktopChatFacade, hostChatCheckpointId, hostChatLedgerKey, pendingHostChatPluginIds, type HostChatFacade } from "./chat-bridge";
import { createRuntimeCheckpointCoordinator, type RuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import type { ChatStore } from "@/features/chat/store/types";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { sessionKey } from "@/features/chat/store/persistence";

const desktop = vi.hoisted(() => ({ state: {} as ChatStore, listSessions: vi.fn() }));
vi.mock("@/features/chat/store", async () => ({
  sessionKey: (await import("@/features/chat/store/persistence")).sessionKey,
  useChatStore: { getState: () => desktop.state },
}));
vi.mock("@/lib/ipc", () => ({ ipc: { listSessions: desktop.listSessions } }));
vi.mock("@/lib/transport", async (original) => ({ ...await original<typeof import("@/lib/transport")>(), isWeb: false }));

const bridges: Array<ReturnType<typeof createHostChatBridge>> = [];
afterEach(() => { bridges.splice(0).forEach((bridge) => bridge.dispose()); });
const a: HostChatTarget = { client: "ccgui", engine: "claude", nativeSessionId: "11111111-1111-1111-1111-111111111111",
  guiSessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/one", clientInstanceId: "desktop-1", windowId: "window-1" };
const b: HostChatTarget = { ...a, nativeSessionId: "22222222-2222-2222-2222-222222222222", guiSessionId: "22222222-2222-2222-2222-222222222222", workspacePath: "G:/two" };

describe("desktop facade cost approval", () => {
  it.each([
    ["claude", "saved-model", 43920, false, false],
    ["claude", "saved-model", 49999, false, false],
    ["claude", "saved-model", 50000, false, true],
    ["codex", "gpt-6-astra", 90000, false, false],
    ["claude", "saved-model", 43920, true, true],
    ["codex", "gpt-6-astra", 43920, true, true],
  ] as const)("uses shared policy for %s/%s, %i tokens, mismatch=%s", async (engine, model, used, mismatch, approval) => {
    const facade = await desktopChatFacade();
    const target = { ...a, engine, ...facade.identity };
    const meta = { engine, sessionId: target.nativeSessionId, workspacePath: target.workspacePath, model, promptCache: null };
    const usage = engine === "codex" ? { info: { last_token_usage: { input_tokens: used } } } : { input_tokens: used };
    desktop.state = {
      initialized: true, archivedSessionKeys: {}, models: { [engine]: model }, sessions: [meta],
      openTabs: [{ ...meta }],
      bySession: { [sessionKey(engine, meta.sessionId, meta.workspacePath)]: {
        ...EMPTY_SESSION, usage, messages: [{ model: mismatch ? "old-model" : model, usage }],
      } },
    } as unknown as ChatStore;
    desktop.listSessions.mockResolvedValue([meta]);
    expect(facade.inspect(target)?.status).toBe("idle");
    expect(await facade.requiresCostApproval!(target)).toBe(approval);
  });
});

function coordinator(snapshot?: RuntimeCheckpoint) {
  const checkpoint = createRuntimeCheckpointCoordinator();
  checkpoint.initialize(snapshot, { requiredParticipants: [] });
  return checkpoint;
}
function fixture(pluginId = "one", data = new Map<string, unknown>(), identity: HostChatFacade["identity"] = a,
  checkpoint = coordinator(), now?: () => number) {
  const documentIdentity = { clientInstanceId: identity.clientInstanceId, windowId: identity.windowId };
  const localA = { ...a, ...documentIdentity }; const localB = { ...b, ...documentIdentity };
  const sessions = new Map<string, HostChatSession>([[a.nativeSessionId, { ...localA, status: "idle" }], [b.nativeSessionId, { ...localB, status: "idle" }]]);
  let active = localA;
  const observers = new Set<() => void>();
  let receive: (events: EngineEventPayload[]) => void = () => {};
  const backend = {
    get: vi.fn(async (id: string, key: string) => structuredClone(data.get(`${id}:${key}`) ?? null)),
    set: vi.fn(async (id: string, key: string, value: unknown) => { data.set(`${id}:${key}`, structuredClone(value)); }),
    delete: vi.fn(async () => {}),
  };
  const host: HostChatFacade = {
    identity: { clientInstanceId: identity.clientInstanceId, windowId: identity.windowId },
    current: () => sessions.get(active.nativeSessionId) ?? null,
    inspect: (target) => {
      const session = sessions.get(target.nativeSessionId);
      return session && Object.keys(a).every((key) => session[key as keyof HostChatTarget] === target[key as keyof HostChatTarget]) ? { ...session } : null;
    },
    send: vi.fn(async (target, _prompt, runId) => {
      sessions.set(target.nativeSessionId, { ...target, status: "busy" });
      return { runId, sessionId: target.nativeSessionId };
    }),
    subscribe: (cb) => { observers.add(cb); return () => { observers.delete(cb); }; },
    wasInterrupted: vi.fn(() => false),
  };
  const listen = vi.fn(async (cb: (events: EngineEventPayload[]) => void) => { receive = cb; return () => { receive = () => {}; }; });
  const bridge = createHostChatBridge(pluginId, backend, { host: async () => host, listen, checkpoint, now });
  bridges.push(bridge);
  return { bridge, host, backend, data, sessions, checkpoint, listen,
    activate: (target: HostChatTarget) => { active = target; observers.forEach((cb) => cb()); },
    idle: (target: HostChatTarget) => { sessions.set(target.nativeSessionId, { ...target, status: "idle" }); observers.forEach((cb) => cb()); },
    event: (receipt: HostChatReceipt, seq: number, kind: EngineEventPayload["kind"], value: unknown, patch: Partial<EngineEventPayload> = {}) =>
      receive([{ runId: receipt.runId, engine: receipt.target.engine, sessionId: receipt.target.nativeSessionId, seq, kind, data: value, ...patch }]),
  };
}
async function sent(f: ReturnType<typeof fixture>, count = 1) {
  await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(count));
}

describe("planned host chat bridge handoff", () => {
  it("waits for acceptance persistence before capturing a transferable queued receipt", async () => {
    const f = fixture(); f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    await f.bridge.ready();
    const write = Promise.withResolvers<void>();
    f.backend.set.mockImplementationOnce(async (id, key, value) => { await write.promise; f.data.set(`${id}:${key}`, structuredClone(value)); });
    const accepted = f.bridge.submit({ requestId: "durable-cut", target: a, prompt: "durable before cut" });
    await vi.waitFor(() => expect(f.backend.set).toHaveBeenCalledTimes(1));
    let captured = false;
    const preparing = f.checkpoint.prepare().then((snapshot) => { captured = true; return snapshot; });
    await Promise.resolve(); await Promise.resolve();
    expect(captured).toBe(false);
    write.resolve(); await accepted;
    const snapshot = await preparing;
    const state = snapshot.participants[hostChatCheckpointId("one")] as { ledger: { entries: Array<{ receipt: HostChatReceipt }> } };
    expect(state.ledger.entries[0].receipt.status).toBe("queued");
    expect(f.data.has(`one:${hostChatLedgerKey(a)}`)).toBe(true);
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it("restores a queued acceptance while paused and sends its original run exactly once after resume", async () => {
    const old = fixture(); old.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    const receipt = await old.bridge.submit({ requestId: "queued-cut", target: a, prompt: "preserved queue" });
    const snapshot = await old.checkpoint.prepare(); old.bridge.dispose();
    expect(pendingHostChatPluginIds(snapshot)).toEqual(["one"]);
    const checkpoint = coordinator(snapshot);
    const next = fixture("one", old.data, a, checkpoint);
    await next.bridge.ready();
    expect(next.backend.get).not.toHaveBeenCalled();
    expect(await next.bridge.receipt("queued-cut")).toMatchObject({ status: "queued", runId: receipt.runId });
    expect(next.host.send).not.toHaveBeenCalled();
    await expect(next.bridge.submit({ requestId: "new-while-paused", target: a, prompt: "blocked" })).rejects.toThrow(/paused/);
    await checkpoint.resume(); await sent(next);
    expect(next.host.send).toHaveBeenCalledWith(a, "preserved queue", receipt.runId, undefined);
    expect((await next.bridge.submit({ requestId: "queued-cut", target: a, prompt: "preserved queue" })).runId).toBe(receipt.runId);
    expect(next.host.send).toHaveBeenCalledTimes(1);
  });

  it("reattaches an executing run, rejects duplicate sequence output, and persists its terminal receipt before publishing", async () => {
    const old = fixture();
    const receipt = await old.bridge.submit({ requestId: "running-cut", target: a, prompt: "one run" }); await sent(old);
    old.event(receipt, 1, "delta", "before");
    await vi.waitFor(async () => expect(await old.bridge.receipt("running-cut")).toMatchObject({ status: "executing", text: "before" }));
    await vi.waitFor(() => expect(old.checkpoint.readiness()).toEqual([]));
    const snapshot = await old.checkpoint.prepare(); old.bridge.dispose();
    const checkpoint = coordinator(snapshot); const next = fixture("one", old.data, a, checkpoint);
    next.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    const terminalReceipts: HostChatReceipt[] = [];
    next.bridge.onEvent((update) => {
      if (update.status !== "completed") return;
      const stored = next.data.get(`one:${hostChatLedgerKey(a)}`) as { entries: Array<{ receipt: HostChatReceipt }> };
      expect(stored.entries[0].receipt.status).toBe("completed");
      terminalReceipts.push(update);
    });
    await next.bridge.ready();
    next.event(receipt, 1, "delta", "duplicate");
    next.event(receipt, 2, "delta", " after");
    next.event(receipt, 3, "done", {});
    next.event(receipt, 4, "done", {});
    await vi.waitFor(async () => expect(await next.bridge.receipt("running-cut")).toMatchObject({ status: "completed", text: "before after", runId: receipt.runId }));
    await checkpoint.resume();
    expect(next.host.send).not.toHaveBeenCalled();
    expect(terminalReceipts).toHaveLength(1);
  });

  it("blocks only an unpublished native start and allows the acknowledged running receipt", async () => {
    const old = fixture();
    const ack = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    vi.mocked(old.host.send).mockImplementation(() => ack.promise);
    const receipt = await old.bridge.submit({ requestId: "pending-ack", target: a, prompt: "wait for acknowledgement" }); await sent(old);
    await expect(old.checkpoint.prepare()).rejects.toThrow(/native-start-unpublished/);
    old.event(receipt, 1, "delta", "already arrived");
    ack.resolve({ runId: receipt.runId, sessionId: a.nativeSessionId });
    await vi.waitFor(() => expect(old.checkpoint.readiness()).toEqual([]));
    const snapshot = await old.checkpoint.prepare();
    const bridge = snapshot.participants[hostChatCheckpointId("one")] as { acknowledgedRuns: string[]; ledger: { entries: Array<{ receipt: HostChatReceipt }> } };
    expect(bridge.acknowledgedRuns).toContain(receipt.runId);
    expect(bridge.ledger.entries[0].receipt).toMatchObject({ status: "executing", text: "already arrived" });
  });

  it("retains restored private start proofs through a StrictMode dispose/recreate before commit", async () => {
    const old = fixture();
    vi.mocked(old.host.send).mockImplementation(async (_target, _prompt, runId) => ({ runId, sessionId: null }));
    const receipt = await old.bridge.submit({ requestId: "strict-cut", target: a, prompt: "no duplicate" }); await sent(old);
    await vi.waitFor(() => expect(old.checkpoint.readiness()).toEqual([]));
    const snapshot = await old.checkpoint.prepare(); old.bridge.dispose();
    const checkpoint = coordinator(snapshot);
    const first = fixture("one", old.data, a, checkpoint);
    const listener = Promise.withResolvers<() => void>();
    first.listen.mockImplementationOnce(() => listener.promise);
    const firstReady = first.bridge.ready(); void firstReady.catch(() => {});
    await vi.waitFor(() => expect(first.listen).toHaveBeenCalledTimes(1));
    first.bridge.dispose();
    const second = fixture("one", old.data, a, checkpoint);
    let secondReady = false;
    const waiting = second.bridge.ready().then(() => { secondReady = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(secondReady).toBe(false);
    const off = vi.fn(); listener.resolve(off);
    await expect(firstReady).rejects.toThrow(/disposed/); await waiting;
    expect(off).toHaveBeenCalledTimes(1);
    // A stale cleanup cannot unregister or clear the replacement owner.
    first.bridge.dispose(); expect(checkpoint.readiness()).toEqual([]);
    expect(await second.bridge.receipt("strict-cut")).toMatchObject({ status: "received", runId: receipt.runId });
    second.event(receipt, 1, "session", a.nativeSessionId);
    second.event(receipt, 2, "delta", "continued");
    second.event(receipt, 3, "done", {});
    await vi.waitFor(async () => expect(await second.bridge.receipt("strict-cut")).toMatchObject({ status: "completed", text: "continued" }));
    await checkpoint.resume();
    expect(first.host.send).not.toHaveBeenCalled(); expect(second.host.send).not.toHaveBeenCalled();
  });

  it("does not let a disposed owner's late ledger read overwrite a synchronously restored checkpoint", async () => {
    const source = fixture("source"); source.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    const accepted = await source.bridge.submit({ requestId: "accepted", target: a, prompt: "authoritative cut" });
    const snapshot = await source.checkpoint.prepare(); source.bridge.dispose();
    const checkpoint = coordinator(); const data = new Map<string, unknown>();
    const stale = fixture("source", data, a, checkpoint);
    const loaded = Promise.withResolvers<{} | null>(); stale.backend.get.mockImplementationOnce(() => loaded.promise);
    const staleReady = stale.bridge.ready(); void staleReady.catch(() => {});
    await vi.waitFor(() => expect(stale.backend.get).toHaveBeenCalledTimes(1));
    stale.bridge.dispose(); checkpoint.initialize(snapshot, { requiredParticipants: [] });
    const restored = fixture("source", data, a, checkpoint);
    await restored.bridge.ready();
    loaded.resolve({ version: 1, entries: [] });
    await expect(staleReady).rejects.toThrow(/disposed/);
    expect(stale.backend.set).not.toHaveBeenCalled(); expect(restored.backend.get).not.toHaveBeenCalled();
    expect(await restored.bridge.receipt("accepted")).toMatchObject({ status: "queued", runId: accepted.runId });
    const stored = data.get(`source:${hostChatLedgerKey(a)}`) as { entries: Array<{ receipt: HostChatReceipt }> };
    expect(stored.entries[0].receipt.requestId).toBe("accepted");
    expect(restored.host.send).not.toHaveBeenCalled();
  });
});

describe("desktop existing host chat request ledger", () => {
  it("returns exact desktop identity without requiring or reading a current conversation", async () => {
    const f = fixture(); f.sessions.clear(); const current = vi.spyOn(f.host, "current");
    const identity = await f.bridge.identity();
    expect(identity).toEqual({ clientInstanceId: a.clientInstanceId, windowId: a.windowId });
    expect(current).not.toHaveBeenCalled(); expect(await f.bridge.current()).toBeNull();
    (identity as { clientInstanceId: string }).clientInstanceId = "mutated";
    expect((await f.bridge.identity()).clientInstanceId).toBe(a.clientInstanceId);
    expect(f.host.send).not.toHaveBeenCalled();
  });
  it("persists acceptance and executing fence before exact original timeline send", async () => {
    const f = fixture();
    const order: string[] = [];
    f.backend.set.mockImplementation(async (id, key, value) => {
      order.push((value as { entries: Array<{ receipt: HostChatReceipt }> }).entries[0].receipt.status);
      f.data.set(`${id}:${key}`, structuredClone(value));
    });
    vi.mocked(f.host.send).mockImplementation(async (target, prompt, runId) => {
      order.push("send");
      expect(target).toEqual(a); expect(prompt).toBe("Canvas instruction");
      return { runId, sessionId: a.nativeSessionId };
    });
    const receipt = await f.bridge.submit({ requestId: "request-1", target: a, prompt: "Canvas instruction" });
    await sent(f);
    expect(order.slice(0, 3)).toEqual(["received", "executing", "send"]);
    expect(receipt.target).toEqual(a);
    expect(await f.bridge.current()).toMatchObject(a);
  });

  it("keeps two sessions and a busy queue bound to the frozen target after active switch", async () => {
    const f = fixture();
    f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    const receipt = await f.bridge.submit({ requestId: "queued", target: a, prompt: "A only" });
    expect(receipt.status).toBe("queued");
    f.activate(b);
    await f.bridge.submit({ requestId: "other", target: b, prompt: "B only" });
    await sent(f);
    expect(vi.mocked(f.host.send).mock.calls[0][0]).toEqual(b);
    f.idle(a);
    await sent(f, 2);
    expect(vi.mocked(f.host.send).mock.calls[1][0]).toEqual(a);
  });

  it("rejects mismatched source, missing native ID and unreachable targets without substitution", async () => {
    const f = fixture();
    for (const target of [{ ...a, clientInstanceId: "other" }, { ...a, workspacePath: "wrong" }, { ...a, nativeSessionId: "" }, { ...a, guiSessionId: b.guiSessionId }]) {
      await expect(f.bridge.submit({ requestId: "bad", target, prompt: "never" })).rejects.toThrow();
    }
    f.sessions.delete(a.nativeSessionId);
    expect(await f.bridge.inspect(a)).toBeNull();
    await expect(f.bridge.submit({ requestId: "closed", target: a, prompt: "never" })).rejects.toThrow(/unavailable/);
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it("serializes identical duplicates and rejects changed payloads while isolating plugins", async () => {
    const data = new Map<string, unknown>();
    const f = fixture("one", data);
    const request = { requestId: "same", target: a, prompt: "once" };
    const receipts = await Promise.all([f.bridge.submit(request), f.bridge.submit(request)]);
    await sent(f);
    expect(receipts[0].runId).toBe(receipts[1].runId);
    await expect(f.bridge.submit({ ...request, prompt: "changed" })).rejects.toThrow(/different/);
    await expect(f.bridge.submit({ ...request, target: b })).rejects.toThrow(/different/);
    const other = fixture("two", data);
    expect(await other.bridge.receipt("same")).toBeNull();
    const received = vi.fn(); other.bridge.onEvent(received);
    f.event(receipts[0], 1, "delta", "owned");
    await vi.waitFor(async () => expect((await f.bridge.receipt("same"))?.text).toBe("owned"));
    expect(received).not.toHaveBeenCalled();
  });

  it("does not acknowledge or send when acceptance storage fails", async () => {
    const f = fixture(); f.backend.set.mockRejectedValueOnce(new Error("disk"));
    await expect(f.bridge.submit({ requestId: "disk", target: a, prompt: "never" })).rejects.toThrow(/could not be persisted/);
    expect(f.host.send).not.toHaveBeenCalled(); expect(await f.bridge.receipt("disk")).toBeNull();
  });

  it("fences an acceptance write that committed but lost its acknowledgement", async () => {
    const f = fixture(); f.backend.set.mockImplementationOnce(async (id, key, value) => {
      f.data.set(`${id}:${key}`, structuredClone(value)); throw new Error("ack lost");
    });
    await expect(f.bridge.submit({ requestId: "lost-ack", target: a, prompt: "never replay" })).rejects.toThrow(/could not be persisted/);
    expect(f.host.send).not.toHaveBeenCalled(); f.bridge.dispose();
    const recovered = fixture("one", f.data);
    expect((await recovered.bridge.receipt("lost-ack"))?.status).toBe("unknown");
    await recovered.bridge.submit({ requestId: "lost-ack", target: a, prompt: "never replay" });
    expect(recovered.host.send).not.toHaveBeenCalled();
  });

  it("never starts a restored busy acceptance whose queued write committed then threw", async () => {
    const f = fixture(); f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    f.backend.set.mockImplementationOnce(async (id, key, value) => {
      f.data.set(`${id}:${key}`, structuredClone(value)); throw new Error("queued ack lost");
    });
    await expect(f.bridge.submit({ requestId: "busy-lost-ack", target: a, prompt: "never replay" })).rejects.toThrow(/could not be persisted/);
    expect(await f.bridge.receipt("busy-lost-ack")).toBeNull(); expect(f.host.send).not.toHaveBeenCalled(); f.bridge.dispose();
    const recovered = fixture("one", f.data); // Same document, now idle.
    expect((await recovered.bridge.receipt("busy-lost-ack"))?.status).toBe("unknown");
    expect((await recovered.bridge.submit({ requestId: "busy-lost-ack", target: a, prompt: "never replay" })).status).toBe("unknown");
    recovered.idle(a); await recovered.bridge.receipt("busy-lost-ack");
    expect(recovered.host.send).not.toHaveBeenCalled();
  });

  it("fences a crash/failed durable executing transition before spawn", async () => {
    const f = fixture();
    f.backend.set.mockImplementationOnce(async (id, key, value) => { f.data.set(`${id}:${key}`, structuredClone(value)); }).mockRejectedValueOnce(new Error("disk"));
    await f.bridge.submit({ requestId: "fence", target: a, prompt: "never" });
    await vi.waitFor(async () => expect((await f.bridge.receipt("fence"))?.status).toBe("unknown"));
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it("preserves an old document ledger without loading or replaying its started/queued requests", async () => {
    const f = fixture();
    await f.bridge.submit({ requestId: "started", target: a, prompt: "once" }); await sent(f);
    f.sessions.set(b.nativeSessionId, { ...b, status: "busy" });
    await f.bridge.submit({ requestId: "queued", target: b, prompt: "later" });
    f.bridge.dispose();
    const previous = structuredClone(f.data.get(`one:${hostChatLedgerKey(a)}`));
    const recovered = fixture("one", f.data, { clientInstanceId: "new-document", windowId: "new-window" });
    expect(await recovered.bridge.receipt("started")).toBeNull();
    expect(await recovered.bridge.receipt("queued")).toBeNull();
    expect(await recovered.bridge.inspect(a)).toBeNull();
    await expect(recovered.bridge.submit({ requestId: "started", target: a, prompt: "once" })).rejects.toThrow(/different desktop document/);
    expect(recovered.host.send).not.toHaveBeenCalled();
    expect(f.data.get(`one:${hostChatLedgerKey(a)}`)).toEqual(previous);
  });

  it("keeps simultaneous documents of the same plugin in separate durable keys without clobber or foreign adoption", async () => {
    const data = new Map<string, unknown>();
    const first = fixture("one", data);
    const second = fixture("one", data, { clientInstanceId: "desktop-2", windowId: "window-2" });
    const secondTarget = (await second.bridge.current())!;
    await Promise.all([
      first.bridge.submit({ requestId: "first", target: a, prompt: "first document" }),
      second.bridge.submit({ requestId: "second", target: secondTarget, prompt: "second document" }),
    ]);
    await sent(first); await sent(second);
    expect(data.has(`one:${hostChatLedgerKey(a)}`)).toBe(true);
    expect(data.has(`one:${hostChatLedgerKey(secondTarget)}`)).toBe(true);
    expect(await first.bridge.receipt("second")).toBeNull(); expect(await second.bridge.receipt("first")).toBeNull();
    expect(await first.bridge.inspect(secondTarget)).toBeNull(); expect(await second.bridge.inspect(a)).toBeNull();
    await expect(second.bridge.submit({ requestId: "foreign", target: a, prompt: "never" })).rejects.toThrow(/different desktop document/);
    expect(first.host.send).toHaveBeenCalledTimes(1); expect(second.host.send).toHaveBeenCalledTimes(1);
  });

  it.each(["queued", "received", "executing", "awaiting_permission", "awaiting_cost_approval"])("does not replay a reloaded %s request even in the same test document identity", async (status) => {
    const f = fixture(); f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    await f.bridge.submit({ requestId: "crash", target: a, prompt: "once" }); f.bridge.dispose();
    const ledger = structuredClone(f.data.get(`one:${hostChatLedgerKey(a)}`)) as { entries: Array<{ receipt: { status: string } }> };
    ledger.entries[0].receipt.status = status; f.data.set(`one:${hostChatLedgerKey(a)}`, ledger);
    const recovered = fixture("one", f.data);
    expect((await recovered.bridge.receipt("crash"))?.status).toBe("unknown"); expect(recovered.host.send).not.toHaveBeenCalled();
  });

  it("keeps permission/question cards in GUI and ignores wrong/duplicate/late events", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    const receipt = await f.bridge.submit({ requestId: "events", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 100, "delta", "wrong", { sessionId: b.nativeSessionId });
    f.event(receipt, 101, "delta", "wrong", { engine: "codex" });
    f.event(receipt, 1, "question", { secret: "do not expose raw input" });
    await vi.waitFor(async () => expect((await f.bridge.receipt("events"))?.status).toBe("awaiting_permission"));
    expect(changes.mock.calls.flat().some((r) => JSON.stringify(r).includes("secret"))).toBe(false);
    f.event(receipt, 2, "question_settled", {});
    f.event(receipt, 3, "delta", "result"); f.event(receipt, 3, "delta", "duplicate");
    f.event(receipt, 4, "done", {}); f.event(receipt, 5, "delta", "late");
    await vi.waitFor(async () => expect(await f.bridge.receipt("events")).toMatchObject({ status: "completed", text: "result", target: a }));
    expect(f.host.send).toHaveBeenCalledTimes(1);
  });

  it("bounds output, returns failures and preserves terminal state on duplicate done", async () => {
    const f = fixture(); const receipt = await f.bridge.submit({ requestId: "bounded", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "x".repeat(100_000));
    f.event(receipt, 2, "error", "e".repeat(3000)); f.event(receipt, 3, "done", {});
    await vi.waitFor(async () => {
      const result = await f.bridge.receipt("bounded");
      expect(result?.status).toBe("failed"); expect(result?.text).toHaveLength(65_536); expect(result?.error).toHaveLength(1024); expect(result?.truncated).toBe(true);
    });
  });

  it("marks and persists a surrogate-safe truncated prefix without stitching later text onto it", async () => {
    const f = fixture(); const notices = vi.fn(); f.bridge.onEvent(notices);
    const receipt = await f.bridge.submit({ requestId: "unicode", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "中".repeat(65_535) + "😀原完整结果");
    f.event(receipt, 2, "delta", "later"); f.event(receipt, 3, "done", {});
    await vi.waitFor(async () => expect(await f.bridge.receipt("unicode")).toMatchObject({ status: "completed", text: "中".repeat(65_535), truncated: true }));
    const saved = f.data.get(`one:${hostChatLedgerKey(a)}`) as { entries: Array<{ receipt: HostChatReceipt }> };
    expect(saved.entries[0].receipt.truncated).toBe(true);
    expect(notices.mock.calls.some(([value]) => value.truncated === true)).toBe(true);
    expect(saved.entries[0].receipt.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("settles a Stop that interrupts only the reply as the same interrupted failure a kill gets", async () => {
    const f = fixture(); const receipt = await f.bridge.submit({ requestId: "reply-only-stop", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "partial");
    // The store sets no interrupted flag for this Stop: the run lives on for its background tasks.
    f.event(receipt, 2, "turn_complete", { usage: null, interrupted: true });
    await vi.waitFor(async () => expect(await f.bridge.receipt("reply-only-stop")).toMatchObject({
      status: "failed", error: "Original GUI turn was interrupted", text: "partial", target: a }));
    expect(f.host.wasInterrupted).not.toHaveBeenCalled();
    // The run keeps going; its final done, delta or error cannot turn the stopped request around.
    f.event(receipt, 3, "delta", "late"); f.event(receipt, 4, "done", {});
    await f.bridge.receipt("reply-only-stop");
    expect(await f.bridge.receipt("reply-only-stop")).toMatchObject({ status: "failed", text: "partial" });
  });

  it("does not treat an ordinary response boundary as the end of the request", async () => {
    const f = fixture(); const receipt = await f.bridge.submit({ requestId: "boundary", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "first reply"); f.event(receipt, 2, "turn_complete", { usage: null });
    f.event(receipt, 3, "turn_complete", { usage: null, interrupted: false });
    await vi.waitFor(async () => expect(await f.bridge.receipt("boundary")).toMatchObject({ status: "executing", text: "first reply" }));
    f.event(receipt, 4, "done", {});
    await vi.waitFor(async () => expect((await f.bridge.receipt("boundary"))?.status).toBe("completed"));
  });

  it("holds an early interrupted response until the ACK like any terminal result", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    let resolve!: (v: { runId: string; sessionId: string | null }) => void;
    vi.mocked(f.host.send).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const receipt = await f.bridge.submit({ requestId: "early-stop", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "partial"); f.event(receipt, 2, "turn_complete", { usage: null, interrupted: true });
    await vi.waitFor(async () => expect(await f.bridge.receipt("early-stop")).toMatchObject({ status: "executing", text: "partial" }));
    expect(changes.mock.calls.some(([value]) => value.status === "failed")).toBe(false);
    resolve({ runId: receipt.runId, sessionId: a.nativeSessionId });
    await vi.waitFor(async () => expect(await f.bridge.receipt("early-stop")).toMatchObject({ status: "failed", error: "Original GUI turn was interrupted" }));
  });

  it("keeps the kill case settled with the same wording", async () => {
    const f = fixture(); vi.mocked(f.host.wasInterrupted).mockReturnValue(true);
    const receipt = await f.bridge.submit({ requestId: "killed", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "done", {});
    await vi.waitFor(async () => expect(await f.bridge.receipt("killed")).toMatchObject({ status: "failed", error: "Original GUI turn was interrupted" }));
  });

  it("never rebinds an unexpected native session announcement", async () => {
    const f = fixture(); const receipt = await f.bridge.submit({ requestId: "session", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "session", b.nativeSessionId); f.event(receipt, 2, "done", {});
    await vi.waitFor(async () => expect(await f.bridge.receipt("session")).toMatchObject({ status: "unknown", target: a }));
  });

  it.each(["run", "session", "rejected"])("holds an early done until ACK, then emits unknown for a %s ACK mismatch/failure", async (kind) => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    let resolve!: (v: { runId: string; sessionId: string | null }) => void;
    let reject!: (reason: unknown) => void;
    vi.mocked(f.host.send).mockImplementation(() => new Promise((r, j) => { resolve = r; reject = j; }));
    const receipt = await f.bridge.submit({ requestId: "early", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "early"); f.event(receipt, 2, "done", {});
    await vi.waitFor(async () => expect(await f.bridge.receipt("early")).toMatchObject({ status: "executing", text: "early" }));
    expect(changes.mock.calls.some(([value]) => value.status === "completed" || value.status === "failed")).toBe(false);
    if (kind === "rejected") reject(new Error("ACK transport lost"));
    else resolve({ runId: kind === "run" ? "different" : receipt.runId, sessionId: kind === "session" ? b.nativeSessionId : a.nativeSessionId });
    await vi.waitFor(async () => expect((await f.bridge.receipt("early"))?.status).toBe("unknown"));
    expect(changes.mock.calls.some(([value]) => value.status === "completed" || value.status === "failed")).toBe(false);
  });

  it.each(["done", "error"] as const)("publishes a buffered early %s terminal exactly once after matching delayed ACK", async (kind) => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    let resolve!: (v: { runId: string; sessionId: string | null }) => void;
    vi.mocked(f.host.send).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const receipt = await f.bridge.submit({ requestId: "delayed", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "early"); f.event(receipt, 2, kind, kind === "error" ? "engine failed" : {});
    await vi.waitFor(async () => expect(await f.bridge.receipt("delayed")).toMatchObject({ status: "executing", text: "early" }));
    expect(changes.mock.calls.some(([value]) => value.status === "completed" || value.status === "failed")).toBe(false);
    resolve({ runId: receipt.runId, sessionId: a.nativeSessionId });
    const expected = kind === "done" ? "completed" : "failed";
    await vi.waitFor(async () => expect((await f.bridge.receipt("delayed"))?.status).toBe(expected));
    f.event(receipt, 3, kind, "duplicate"); await f.bridge.receipt("delayed");
    expect(changes.mock.calls.filter(([value]) => value.status === expected)).toHaveLength(1);
  });

  it("honors resumed Claude wire ACK {runId,sessionId:null} and waits for native session identity while B is current", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    // engine/mod.rs returns BuiltCommand.preassigned_session_id; Claude leaves
    // it None even for --resume. serde sends null, not the requested UUID.
    vi.mocked(f.host.send).mockImplementation(async (target, _prompt, runId) => {
      f.sessions.set(target.nativeSessionId, { ...target, status: "busy" });
      return JSON.parse(JSON.stringify({ runId, sessionId: null }));
    });
    const receipt = await f.bridge.submit({ requestId: "claude-wire", target: a, prompt: "act" }); await sent(f); f.activate(b);
    f.event(receipt, 1, "model", "session-model", { sessionId: null });
    f.event(receipt, 2, "effort", "high", { sessionId: null });
    expect((await f.bridge.receipt("claude-wire"))?.status).toBe("received");
    expect(changes.mock.calls.some(([value]) => value.status === "executing" || value.status === "completed")).toBe(false);
    // reader::adopt_session_id sets native UUID before publishing "session".
    f.event(receipt, 3, "session", a.nativeSessionId);
    await vi.waitFor(async () => expect((await f.bridge.receipt("claude-wire"))?.status).toBe("executing"));
    f.event(receipt, 4, "delta", "wire result"); f.event(receipt, 5, "done", { usage: null });
    await vi.waitFor(async () => expect(await f.bridge.receipt("claude-wire")).toMatchObject({ status: "completed", text: "wire result", target: a }));
    expect(await f.bridge.current()).toMatchObject(b); expect(f.host.send).toHaveBeenCalledWith(a, "act", receipt.runId, undefined);
    expect(changes.mock.calls.filter(([value]) => value.status === "completed")).toHaveLength(1);
  });

  it.each(["done", "error"] as const)("accepts native identity/%s before delayed null-session ACK without publishing terminal early", async (kind) => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    let resolve!: (value: { runId: string; sessionId: string | null }) => void;
    vi.mocked(f.host.send).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const receipt = await f.bridge.submit({ requestId: "claude-early-wire", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "session", a.nativeSessionId); f.event(receipt, 2, "delta", "early wire");
    f.event(receipt, 3, kind, kind === "done" ? { usage: null } : "wire error");
    await vi.waitFor(async () => expect(await f.bridge.receipt("claude-early-wire")).toMatchObject({ status: "executing", text: "early wire" }));
    expect(changes.mock.calls.some(([value]) => value.status === "completed" || value.status === "failed")).toBe(false);
    resolve(JSON.parse(JSON.stringify({ runId: receipt.runId, sessionId: null })));
    const terminal = kind === "done" ? "completed" : "failed";
    await vi.waitFor(async () => expect((await f.bridge.receipt("claude-early-wire"))?.status).toBe(terminal));
    expect(changes.mock.calls.filter(([value]) => value.status === terminal)).toHaveLength(1);
  });

  it("does not infer UUID from target when null-session ACK and native envelopes supply no identity", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    vi.mocked(f.host.send).mockImplementation(async (_target, _prompt, runId) => ({ runId, sessionId: null }));
    const receipt = await f.bridge.submit({ requestId: "no-native-identity", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "model", "session-model", { sessionId: null });
    f.event(receipt, 2, "done", { usage: null }, { sessionId: null });
    expect((await f.bridge.receipt("no-native-identity"))?.status).toBe("received");
    expect(changes.mock.calls.some(([value]) => value.status === "completed")).toBe(false); f.bridge.dispose();
    const recovered = fixture("one", f.data);
    expect((await recovered.bridge.receipt("no-native-identity"))?.status).toBe("unknown"); expect(recovered.host.send).not.toHaveBeenCalled();
  });

  it("rejects explicit wrong native session announcement after null-session ACK without rebinding", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    vi.mocked(f.host.send).mockImplementation(async (_target, _prompt, runId) => ({ runId, sessionId: null }));
    const receipt = await f.bridge.submit({ requestId: "wrong-native-identity", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "session", b.nativeSessionId, { sessionId: b.nativeSessionId });
    await vi.waitFor(async () => expect(await f.bridge.receipt("wrong-native-identity")).toMatchObject({ status: "unknown", target: a }));
    expect(changes.mock.calls.some(([value]) => value.status === "completed")).toBe(false);
  });

  it("publishes unknown if persisting buffered completion fails after matching ACK and never replays", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes);
    let resolve!: (v: { runId: string; sessionId: string | null }) => void;
    vi.mocked(f.host.send).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const receipt = await f.bridge.submit({ requestId: "ack-disk", target: a, prompt: "act" }); await sent(f);
    f.event(receipt, 1, "delta", "early"); f.event(receipt, 2, "done", {});
    await vi.waitFor(async () => expect(await f.bridge.receipt("ack-disk")).toMatchObject({ status: "executing", text: "early" }));
    f.backend.set.mockRejectedValueOnce(new Error("disk after ACK")); resolve({ runId: receipt.runId, sessionId: a.nativeSessionId });
    await vi.waitFor(async () => expect((await f.bridge.receipt("ack-disk"))?.status).toBe("unknown"));
    expect(changes.mock.calls.some(([value]) => value.status === "completed")).toBe(false); f.bridge.dispose();
    const recovered = fixture("one", f.data);
    expect((await recovered.bridge.receipt("ack-disk"))?.status).toBe("unknown"); expect(recovered.host.send).not.toHaveBeenCalled();
  });

  it("keeps a typed pre-spawn busy race private from onEvent, receipt polls and duplicate submit", async () => {
    const f = fixture(); const changes = vi.fn(); f.bridge.onEvent(changes); const nativeStarts = vi.fn();
    let release!: () => void; const beforeSpawn = new Promise<void>((r) => { release = r; });
    vi.mocked(f.host.send).mockImplementationOnce(async (target, _prompt, runId) => {
      await beforeSpawn;
      if (f.host.inspect(target)?.status !== "idle") throw new HostChatBusyError();
      nativeStarts(); return { runId, sessionId: target.nativeSessionId };
    });
    const request = { requestId: "private-busy", target: a, prompt: "act" };
    await f.bridge.submit(request); await sent(f);
    const polls = await Promise.all([f.bridge.receipt(request.requestId), f.bridge.receipt(request.requestId), f.bridge.submit(request)]);
    expect(polls.every((value) => value?.status === "received")).toBe(true);
    f.sessions.set(a.nativeSessionId, { ...a, status: "busy" }); release();
    await vi.waitFor(async () => expect((await f.bridge.receipt(request.requestId))?.status).toBe("queued"));
    expect(changes.mock.calls.some(([value]) => value.status === "executing")).toBe(false);
    expect(nativeStarts).not.toHaveBeenCalled(); expect(f.host.send).toHaveBeenCalledTimes(1);
  });

  it("queues a pre-spawn busy race and never auto-replays ambiguous invoke failure", async () => {
    const f = fixture();
    vi.mocked(f.host.send).mockImplementationOnce(async () => {
      f.sessions.set(a.nativeSessionId, { ...a, status: "busy" }); throw new HostChatBusyError();
    });
    await f.bridge.submit({ requestId: "race", target: a, prompt: "act" }); await sent(f);
    await vi.waitFor(async () => expect((await f.bridge.receipt("race"))?.status).toBe("queued"));
    vi.mocked(f.host.send).mockRejectedValueOnce(new Error("transport closed")); f.idle(a);
    await vi.waitFor(async () => expect((await f.bridge.receipt("race"))?.status).toBe("unknown"));
    expect(f.host.send).toHaveBeenCalledTimes(2);
  });

  it("copies mutable submissions/receipts and disposes subscriptions on unload", async () => {
    const f = fixture(); f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    const target = { ...a }; const submission = { requestId: "copy", target, prompt: "original" };
    const pending = f.bridge.submit(submission); submission.prompt = "mutated"; target.workspacePath = "mutated";
    const receipt = await pending; (receipt.target as { workspacePath: string }).workspacePath = "changed";
    expect((await f.bridge.receipt("copy"))?.target).toEqual(a);
    const listener = vi.fn(); f.bridge.onEvent(listener); f.bridge.dispose(); f.idle(a);
    expect(f.host.send).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
    expect(f.data.has(`one:${hostChatLedgerKey(a)}`)).toBe(true);
  });

  it("does not let a disposed bridge's late native acknowledgement overwrite its replacement ledger", async () => {
    const old = fixture(); let resolve!: (v: { runId: string; sessionId: string | null }) => void;
    vi.mocked(old.host.send).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await old.bridge.submit({ requestId: "old", target: a, prompt: "old" }); await sent(old); old.bridge.dispose();
    const replacement = fixture("one", old.data);
    expect((await replacement.bridge.receipt("old"))?.status).toBe("unknown");
    await replacement.bridge.submit({ requestId: "new", target: b, prompt: "new" }); await sent(replacement);
    const saved = structuredClone(old.data.get(`one:${hostChatLedgerKey(a)}`));
    resolve({ runId: "unexpected-old", sessionId: a.nativeSessionId });
    await new Promise((r) => setTimeout(r, 0));
    expect(old.data.get(`one:${hostChatLedgerKey(a)}`)).toEqual(saved);
    expect(await replacement.bridge.receipt("new")).not.toBeNull();
  });
});

describe("host-only cost approval", () => {
  it("requires fresh approval when a queued approved request's model changes", async () => {
    const f = fixture();
    let model = "model-a"; f.host.model = () => model;
    await f.bridge.submitForCostApproval({ requestId: "model-queue", target: a, prompt: "review model" });
    f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    expect(await f.bridge.approveCost("model-queue", "model-a")).toMatchObject({ status: "queued" });
    model = "model-b"; f.idle(a); await f.bridge.ready();
    expect(await f.bridge.receipt("model-queue")).toMatchObject({ status: "awaiting_cost_approval" });
    expect(f.host.send).not.toHaveBeenCalled();
    await f.bridge.approveCost("model-queue", "model-b"); await sent(f);
  });

  it("rejects an approval based on a stale reviewed model and gates a stale guarded submission", async () => {
    const f = fixture("one", new Map(), a, coordinator(), () => 100);
    f.host.model = () => "model-b";
    expect(await f.bridge.submitWithCostGuard({ requestId: "model-guard", target: a, prompt: "review model" }, "model-a"))
      .toMatchObject({ status: "awaiting_cost_approval" });
    await expect(f.bridge.approveCost("model-guard", "model-a")).rejects.toThrow(/model changed/);
    expect(await f.bridge.receipt("model-guard")).toMatchObject({ status: "awaiting_cost_approval" });
    await f.bridge.ready(); expect(f.host.send).not.toHaveBeenCalled();
  });

  it.each([{ costGuard: "yes" }, { costGuard: false }, { costReviewedModel: 1 }])("rejects malformed internal cost metadata %j", async (invalid) => {
    const f = fixture();
    await f.bridge.submitForCostApproval({ requestId: "malformed-cost", target: a, prompt: "never" });
    const key = `one:${hostChatLedgerKey(a)}`;
    const ledger = structuredClone(f.data.get(key)) as { entries: Array<Record<string, unknown>> };
    Object.assign(ledger.entries[0], invalid); f.data.set(key, ledger); f.bridge.dispose();
    const next = fixture("one", f.data);
    await expect(next.bridge.ready()).rejects.toThrow(/Invalid host chat request ledger/);
  });

  it("queues a guarded submission when the target is busy and evaluates latest cache evidence before sending", async () => {
    let cacheCold = false;
    const f = fixture("one", new Map(), a, coordinator(), () => 100);
    f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    expect(await f.bridge.submitWithCostGuard({ requestId: "busy-guard", target: a, prompt: "later" }, null, () => cacheCold))
      .toMatchObject({ status: "queued" });
    await f.bridge.ready(); expect(f.host.send).not.toHaveBeenCalled();
    // If cache became cold while waiting in queue, idle transition holds for approval instead of sending
    cacheCold = true;
    f.idle(a); await f.bridge.ready();
    expect(await f.bridge.receipt("busy-guard")).toMatchObject({ status: "awaiting_cost_approval" });
    expect(f.host.send).not.toHaveBeenCalled();
    await f.bridge.approveCost("busy-guard"); await sent(f);
  });

  it.each(["busy", "expired"] as const)("rechecks guarded acceptance after persistence (%s)", async (cause) => {
    let cacheExpired = false;
    const f = fixture("one", new Map(), a, coordinator());
    const write = Promise.withResolvers<void>();
    f.backend.set.mockImplementationOnce(async (id, key, value) => {
      await write.promise; f.data.set(`${id}:${key}`, structuredClone(value));
    });
    const request = { requestId: "accept-guard", target: a, prompt: "guarded" };
    const accepting = f.bridge.submitWithCostGuard(request, null, () => cacheExpired);
    await vi.waitFor(() => expect(f.backend.set).toHaveBeenCalledTimes(1));
    if (cause === "busy") f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    else cacheExpired = true;
    write.resolve(); await accepting;
    await f.bridge.ready();
    expect(await f.bridge.submit(request)).toMatchObject({ status: cause === "busy" ? "queued" : "awaiting_cost_approval" });
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it.each(["busy", "expired", "model"] as const)("rechecks the durable pre-send fence (%s)", async (cause) => {
    let cacheExpired = false;
    const f = fixture("one", new Map(), a, coordinator());
    let model = "model-a"; f.host.model = () => model;
    const write = Promise.withResolvers<void>();
    f.backend.set.mockImplementationOnce(async (id, key, value) => { f.data.set(`${id}:${key}`, structuredClone(value)); })
      .mockImplementationOnce(async (id, key, value) => {
        await write.promise; f.data.set(`${id}:${key}`, structuredClone(value));
      });
    await f.bridge.submitWithCostGuard({ requestId: "send-guard", target: a, prompt: "guarded" }, "model-a", () => cacheExpired);
    await vi.waitFor(() => expect(f.backend.set).toHaveBeenCalledTimes(2));
    if (cause === "busy") f.sessions.set(a.nativeSessionId, { ...a, status: "awaiting_permission" });
    else if (cause === "expired") cacheExpired = true;
    else model = "model-b";
    write.resolve(); await f.bridge.ready();
    expect(await f.bridge.receipt("send-guard")).toMatchObject({ status: cause === "busy" ? "queued" : "awaiting_cost_approval" });
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it("retains the original guard across ordinary retries and priority, then clears it only on approval", async () => {
    let cacheExpired = false;
    const f = fixture("one", new Map(), a, coordinator());
    const request = { requestId: "retry-guard", target: a, prompt: "guarded" };
    // Accept while idle, then leave the exact target temporarily unavailable.
    f.backend.set.mockImplementationOnce(async (id, key, value) => {
      f.data.set(`${id}:${key}`, structuredClone(value)); f.sessions.delete(a.nativeSessionId);
    });
    await f.bridge.submitWithCostGuard(request, null, () => cacheExpired); await f.bridge.ready();
    expect(await f.bridge.submit(request)).toMatchObject({ status: "received" });
    await f.bridge.submitWithCostGuard(request, null, () => false);
    await f.bridge.prioritize(request.requestId);
    const ledger = () => f.data.get(`one:${hostChatLedgerKey(a)}`) as { entries: Array<{ costGuard?: true }> };
    expect(ledger().entries[0].costGuard).toBe(true);
    expect(f.host.send).not.toHaveBeenCalled();
    cacheExpired = true; f.idle(a); await f.bridge.ready();
    expect(await f.bridge.receipt(request.requestId)).toMatchObject({ status: "awaiting_cost_approval" });
    f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    expect(await f.bridge.approveCost(request.requestId)).toMatchObject({ status: "queued" });
    expect(ledger().entries[0].costGuard).toBeUndefined();
    f.idle(a); await sent(f);
  });

  it("rejects invalid cost guard arguments", async () => {
    const f = fixture();
    await expect(f.bridge.submitWithCostGuard({ requestId: "invalid-guard", target: a, prompt: "never" }, 123 as never)).rejects.toThrow(/model/);
    await expect(f.bridge.submitWithCostGuard({ requestId: "invalid-guard-fn", target: a, prompt: "never" }, null, "not-fn" as never)).rejects.toThrow(/guard/);
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it("persists a gated request and rejects bypass through ordinary retries, priority or changed payloads", async () => {
    const f = fixture();
    const request = { requestId: "cost", target: a, prompt: "expensive work" };
    const accepted = await f.bridge.submitForCostApproval(request);
    expect(accepted.status).toBe("awaiting_cost_approval");
    expect(await f.bridge.submit(request)).toEqual(accepted);
    expect(await f.bridge.submitForCostApproval(request)).toEqual(accepted);
    expect(await f.bridge.prioritize(request.requestId)).toEqual(accepted);
    await expect(f.bridge.submit({ ...request, prompt: "changed" })).rejects.toThrow(/different/);
    await expect(f.bridge.submitForCostApproval({ ...request, target: b })).rejects.toThrow(/different/);
    f.idle(a); await f.bridge.ready();
    expect(f.host.send).not.toHaveBeenCalled();
    const saved = f.data.get(`one:${hostChatLedgerKey(a)}`) as { entries: Array<{ receipt: HostChatReceipt; priority?: true }> };
    expect(saved.entries[0].receipt).toEqual(accepted);
    expect(saved.entries[0].priority).toBeUndefined();
  });

  it("persists approval before sending and serializes double approval to one original run", async () => {
    const f = fixture();
    const accepted = await f.bridge.submitForCostApproval({ requestId: "double", target: a, prompt: "once" });
    await f.bridge.ready();
    const write = Promise.withResolvers<void>();
    f.backend.set.mockImplementationOnce(async (id, key, value) => {
      await write.promise;
      f.data.set(`${id}:${key}`, structuredClone(value));
    });
    const approvals = Promise.all([f.bridge.approveCost("double"), f.bridge.approveCost("double")]);
    await vi.waitFor(() => expect(f.backend.set).toHaveBeenCalledTimes(2));
    expect(f.host.send).not.toHaveBeenCalled();
    write.resolve();
    expect((await approvals).every((receipt) => receipt?.runId === accepted.runId)).toBe(true);
    await sent(f);
    expect(f.host.send).toHaveBeenCalledWith(a, "once", accepted.runId, undefined);
    await f.bridge.approveCost("double"); await f.bridge.ready();
    expect(f.host.send).toHaveBeenCalledTimes(1);
  });

  it.each(["approve-first", "cancel-first"])("serializes approval and cancellation safely (%s)", async (order) => {
    const f = fixture();
    await f.bridge.submitForCostApproval({ requestId: "cancel-race", target: a, prompt: "withdraw" });
    await f.bridge.ready();
    const approve = () => f.bridge.approveCost("cancel-race");
    const cancel = () => f.bridge.cancel("cancel-race");
    await Promise.all(order === "approve-first" ? [approve(), cancel()] : [cancel(), approve()]);
    await f.bridge.ready();
    expect(await f.bridge.receipt("cancel-race")).toMatchObject({ status: "failed" });
    expect(await f.bridge.approveCost("cancel-race")).toMatchObject({ status: "failed" });
    expect(f.host.send).not.toHaveBeenCalled();
  });

  it("uses the target's current busy or permission state at approval without interrupting it", async () => {
    const f = fixture();
    await f.bridge.submitForCostApproval({ requestId: "busy-cost", target: a, prompt: "later" });
    f.sessions.set(a.nativeSessionId, { ...a, status: "awaiting_permission" });
    expect(await f.bridge.approveCost("busy-cost")).toMatchObject({ status: "queued" });
    await f.bridge.ready(); expect(f.host.send).not.toHaveBeenCalled();
    f.idle(a); await sent(f);
  });

  it("keeps an unavailable target gated and fences a failed approval write without sending", async () => {
    const f = fixture();
    await f.bridge.submitForCostApproval({ requestId: "failed-cost", target: a, prompt: "never" });
    f.sessions.delete(a.nativeSessionId);
    await expect(f.bridge.approveCost("failed-cost")).rejects.toThrow(/unavailable/);
    expect(await f.bridge.receipt("failed-cost")).toMatchObject({ status: "awaiting_cost_approval" });
    f.idle(a); await f.bridge.ready();
    f.backend.set.mockRejectedValueOnce(new Error("disk"));
    expect(await f.bridge.approveCost("failed-cost")).toMatchObject({ status: "unknown" });
    await f.bridge.ready(); expect(f.host.send).not.toHaveBeenCalled();
  });

  it("preserves the gate through a runtime checkpoint and resume until explicit approval", async () => {
    const old = fixture();
    const request = { requestId: "cost-cut", target: a, prompt: "after approval" };
    const accepted = await old.bridge.submitForCostApproval(request);
    const snapshot = await old.checkpoint.prepare(); old.bridge.dispose();
    const checkpoint = coordinator(snapshot);
    const next = fixture("one", old.data, a, checkpoint);
    await next.bridge.ready();
    // Ledger restoration normalizes optional text/error/truncation fields.
    expect(await next.bridge.receipt(request.requestId)).toMatchObject(accepted);
    await expect(next.bridge.approveCost(request.requestId)).rejects.toThrow(/paused/);
    await checkpoint.resume(); await next.bridge.ready();
    expect(await next.bridge.submit(request)).toMatchObject(accepted);
    expect(next.host.send).not.toHaveBeenCalled();
    await next.bridge.approveCost(request.requestId); await sent(next);
    expect(next.host.send).toHaveBeenCalledWith(a, request.prompt, accepted.runId, undefined);
  });
});

describe("host-only queue controls for waiting requests", () => {
  /** Target A runs nothing but holds composer-queued rows: busy for ordinary
   *  requests, idle for one the user sent ahead. */
  function composerQueued(f: ReturnType<typeof fixture>) {
    const inspect = f.host.inspect;
    f.host.inspect = (target, options) => {
      const session = inspect(target, options);
      return session && target.nativeSessionId === a.nativeSessionId && !options?.priority ? { ...session, status: "busy" } : session;
    };
  }

  it("sends a prioritized request ahead of the target's queued rows and earlier requests, keeping its run identity", async () => {
    const f = fixture(); composerQueued(f);
    const first = await f.bridge.submit({ requestId: "first", target: a, prompt: "first" });
    const second = await f.bridge.submit({ requestId: "second", target: a, prompt: "second" });
    expect([first.status, second.status]).toEqual(["queued", "queued"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.host.send).not.toHaveBeenCalled();

    const prioritized = await f.bridge.prioritize("second");
    expect(prioritized?.status).toBe("queued");
    await sent(f);
    expect(vi.mocked(f.host.send).mock.calls[0]).toEqual([a, "second", second.runId, { priority: true }]);
    expect((await f.bridge.receipt("first"))?.status).toBe("queued");
    const saved = f.data.get(`one:${hostChatLedgerKey(a)}`) as { entries: Array<{ receipt: HostChatReceipt; priority?: true }> };
    expect(saved.entries.find((entry) => entry.receipt.requestId === "second")?.priority).toBe(true);
  });

  it("waits for a running turn even when prioritized", async () => {
    const f = fixture(); f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    await f.bridge.submit({ requestId: "waits", target: a, prompt: "waits" });
    await f.bridge.prioritize("waits");
    await new Promise((r) => setTimeout(r, 0));
    expect(f.host.send).not.toHaveBeenCalled();
    f.idle(a);
    await sent(f);
  });

  it("cancels only a request that has not started and never sends it", async () => {
    const f = fixture(); f.sessions.set(a.nativeSessionId, { ...a, status: "busy" });
    await f.bridge.submit({ requestId: "withdrawn", target: a, prompt: "withdrawn" });
    const cancelled = await f.bridge.cancel("withdrawn");
    expect(cancelled).toMatchObject({ status: "failed", error: "Cancelled by the user before delivery" });
    expect(await f.bridge.prioritize("withdrawn")).toMatchObject({ status: "failed" });
    f.idle(a);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.host.send).not.toHaveBeenCalled();

    await f.bridge.submit({ requestId: "started", target: b, prompt: "started" });
    await sent(f);
    await vi.waitFor(async () => expect((await f.bridge.receipt("started"))?.status).toBe("executing"));
    expect(await f.bridge.cancel("started")).toMatchObject({ status: "executing" });
    expect(await f.bridge.cancel("missing")).toBeNull();
  });

  it("rejects a ledger whose priority marker is malformed", async () => {
    const data = new Map<string, unknown>();
    const f = fixture("one", data); composerQueued(f);
    await f.bridge.submit({ requestId: "kept", target: a, prompt: "kept" });
    const key = `one:${hostChatLedgerKey(a)}`;
    const ledger = structuredClone(data.get(key)) as { entries: Array<Record<string, unknown>> };
    ledger.entries[0].priority = "yes";
    data.set(key, ledger);
    f.bridge.dispose();
    const replacement = fixture("one", data);
    await expect(replacement.bridge.ready()).rejects.toThrow("Invalid host chat request ledger");
  });
});
