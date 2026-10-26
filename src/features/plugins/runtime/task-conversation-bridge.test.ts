import { describe, expect, it, vi } from "vitest";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import type { EngineEventPayload } from "@/lib/events";
import type { HostTaskFacade } from "./task-facade";

function fixture(saved = new Map<string, unknown>()) {
  const ref = { engine: "codex", sessionId: "native-one", workspacePath: "G:/project" };
  let callback = () => {};
  let events = (_events: EngineEventPayload[]) => {};
  const branches: Awaited<ReturnType<HostTaskFacade["leaderBranches"]>> = [];
  const proofs = new Map<string, { status: "completed" | "failed" | "cancelled" }>();
  const state = { messages: [{ seq: 1, role: "user", text: "initial", ts: null as string | null }], runId: null as string | null, status: "idle" as "idle" | "busy", canDeliver: true };
  const facade = { ready: async () => {}, known: () => true, openBackground: async () => {},
    fixedInstructionsSupported: vi.fn(async () => true),
    conversationState: () => state, leaderBranches: async () => branches,
    listen: async (cb: typeof events) => { events = cb; return () => {}; },
    interrupt: vi.fn(async () => true), stopChild: vi.fn(async () => {}), focus: vi.fn(async () => {}),
    conversationAction: vi.fn(async () => {}),
    subscribe: (cb: () => void) => { callback = cb; return () => {}; },
    continueMessage: vi.fn(async (_ref, _text, _images, runId, fence) => { await fence("turn", runId); state.runId = runId; state.status = "busy"; state.canDeliver = false; return { delivery: "turn", runId }; }),
    settledRun: (runId: string) => proofs.get(runId) ?? null, liveRun: (runId: string) => state.runId === runId ? "codex/native-one" : null,
  };
  const deps = { pluginId: "test", storage: { get: async (_p: string, k: string) => saved.get(k), set: async (_p: string, k: string, v: unknown) => { saved.set(k, structuredClone(v)); }, delete: async () => {} },
    owned: vi.fn(async (id: string) => { if (id !== "root") throw new Error("Unknown owned task"); return { receipt: { requestId: id, workspacePath: ref.workspacePath, session: ref, status: "completed" }, proven: true }; }),
    facade: async () => facade, resolveImages: async (ids: string[]) => ids, now: () => 100, runId: () => "follow-run", hold: vi.fn(),
  };
  const bridge = createTaskConversationBridge(deps as never);
  return { bridge, saved, facade, state, branches, proofs, deps, ref, events: (value: EngineEventPayload[]) => events(value), notify: () => callback() };
}
const message = { conversationRequestId: "root", requestId: "input-one", expectedInputRevision: 0, prompt: "continue" };
describe("owned continuous task conversations", () => {
  it("queues changed instructions during a live turn and persists them only before the next full launch", async () => {
    const f = fixture(); const v1 = { version: "v1", text: "First policy" }, v2 = { version: "v2", text: "Second policy" };
    const owned = await f.deps.owned("root"); f.deps.owned.mockResolvedValue({ ...owned, fixedInstructions: v1 } as never);
    f.state.status = "busy"; f.state.runId = "initial-run"; f.state.canDeliver = true;
    await f.bridge.sendMessage({ ...message, fixedInstructions: v2 }); await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect(f.bridge.capture().records[0].fixedInstructions).toBeUndefined();
    await expect(f.bridge.sendMessage({ ...message, fixedInstructions: v1 })).rejects.toThrow("fingerprint");
    f.state.status = "idle"; f.state.runId = null;
    const original = f.facade.continueMessage.getMockImplementation()!;
    f.facade.continueMessage.mockImplementationOnce(async (...args) => {
      const fence = args[4]; args[4] = async (delivery: string, run: string) => {
        await fence(delivery, run);
        expect((f.saved.get("__host_tasks_v1:conversations") as any).records[0].fixedInstructions).toEqual(v2);
      };
      return original(...args);
    });
    await f.bridge.drain(); expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    f.proofs.set("follow-run", { status: "completed" }); await f.bridge.messageReceipt("root", "input-one"); f.bridge.dispose();
    const cold = fixture(f.saved); await cold.bridge.ready();
    expect(cold.bridge.capture().records[0].fixedInstructions).toEqual(v2);
    expect(cold.facade.continueMessage).not.toHaveBeenCalled(); cold.bridge.dispose();
  });
  it("keeps matching guidance on live input and does not apply a cancelled queued update", async () => {
    const f = fixture(); const policy = { version: "v1", text: "Policy" };
    const owned = await f.deps.owned("root"); f.deps.owned.mockResolvedValue({ ...owned, fixedInstructions: policy } as never);
    f.state.status = "busy"; f.state.runId = "active";
    f.facade.continueMessage.mockImplementationOnce(async (_r, text, _i, _run, fence) => {
      expect(text).toBe("continue"); await fence("steer", "active"); return { delivery: "steer", runId: "active" };
    });
    await f.bridge.sendMessage({ ...message, fixedInstructions: policy }); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.delivery).toBe("steer");
    await f.bridge.sendMessage({ ...message, requestId: "change", expectedInputRevision: 1, fixedInstructions: { version: "v2", text: "Changed" } });
    await f.bridge.drain(); await f.bridge.cancelMessage("root", "change");
    expect(f.bridge.capture().records[0].fixedInstructions).toBeUndefined();
    expect(f.facade.continueMessage).toHaveBeenCalledTimes(1); f.bridge.dispose();
  });
  it("displayText previews and annotates only the exactly committed user row, without rewriting native text", async () => {
    const f = fixture(); const prompt = "{ injected: coordinator protocol }";
    const unrelated = { seq: 8, role: "user", text: prompt, ts: "2026-10-24T00:00:00Z" };
    const sent = { seq: 9, role: "user", text: prompt, ts: "2026-10-24T00:00:01Z" };
    (f.facade.continueMessage as any).mockImplementationOnce(async (_ref: unknown, _p: string, _i: string[], run: string, fence: any, _launch: unknown, onRow: any) => {
      await fence("turn", run); f.state.messages = [unrelated, sent];
      await onRow?.({ ...sent, runId: run }); return { delivery: "turn", runId: run };
    });
    const request = { ...message, prompt, displayText: "用户真实需求😀" };
    expect(await f.bridge.sendMessage(request)).toMatchObject({ preview: "用户真实需求😀" });
    await f.bridge.drain();
    const projected = (await f.bridge.conversation("root")).messages as any[];
    expect(projected[0]).not.toHaveProperty("displayText");
    expect(projected[1]).toMatchObject({ text: prompt, displayText: "用户真实需求😀" });
    expect(sent).not.toHaveProperty("displayText"); expect(sent.text).toBe(prompt);
    await expect(f.bridge.sendMessage({ ...request, displayText: "different goal" })).rejects.toThrow("fingerprint");
    const cut = f.bridge.capture(); f.bridge.dispose();
    const next = fixture(); next.state.messages = [unrelated, sent]; next.bridge.restore(cut);
    expect((await next.bridge.conversation("root")).messages[1]).toMatchObject({ displayText: "用户真实需求😀" });
    next.bridge.dispose();
  });
  it("P1 keeps stop intent after an empty snapshot and stops a late owned child on poll", async () => {
    const f = fixture();
    expect((await f.bridge.stopConversation("root")).status).toBe("cancelled");
    f.branches.push(
      { id: "late", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "late-session", workspacePath: "G:/project", state: "running" },
      { id: "other", parentEngine: "codex", parentSessionId: "unrelated", engine: "codex", sessionId: "other-session", workspacePath: "G:/project", state: "running" },
    );
    const waiting = await f.bridge.conversation("root");
    expect(f.facade.stopChild).toHaveBeenCalledExactlyOnceWith(f.ref, "late");
    expect(waiting).toMatchObject({ status: "stopping", canSend: false, canChangeSelection: false });
    await f.bridge.conversation("root"); expect(f.facade.stopChild).toHaveBeenCalledTimes(1);
    await expect(f.bridge.sendMessage(message)).rejects.toThrow(/cannot accept/);
    f.bridge.dispose();
  });
  it("P1 restores sticky stop intent and stops a child first discovered after cold recovery", async () => {
    const f = fixture(); await f.bridge.stopConversation("root"); f.bridge.dispose();
    const next = fixture(f.saved);
    next.branches.push({ id: "late-restored", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "late-session", workspacePath: "G:/project", state: "running" });
    await next.bridge.conversation("root");
    expect(next.facade.stopChild).toHaveBeenCalledExactlyOnceWith(next.ref, "late-restored");
    expect((await next.bridge.conversation("root")).canSend).toBe(false); next.bridge.dispose();
  });
  it("P1 never releases an observed active child when a later snapshot omits it", async () => {
    const f = fixture(); await f.bridge.stopConversation("root");
    f.branches.push({ id: "late", parentEngine: "codex", parentSessionId: "native-one", engine: "codex", sessionId: "late-session", workspacePath: "G:/project", state: "running" });
    await f.bridge.conversation("root"); f.branches.length = 0;
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "unknown", canSend: false, canChangeSelection: false, children: [{ id: "late", state: "unknown" }] });
    await expect(f.bridge.sendMessage(message)).rejects.toThrow("cannot accept");
    f.bridge.dispose(); const next = fixture(f.saved);
    expect((await next.bridge.conversation("root")).status).toBe("unknown"); next.bridge.dispose();
  });
  it("accepts once with exact fingerprint and input CAS without creating another business task", async () => {
    const f = fixture();
    const first = await f.bridge.sendMessage(message);
    expect(first.inputRevision).toBe(1);
    expect((await f.bridge.sendMessage(message)).requestId).toBe(first.requestId);
    await expect(f.bridge.sendMessage({ ...message, prompt: "changed" })).rejects.toThrow(/fingerprint/i);
    await expect(f.bridge.sendMessage({ ...message, requestId: "input-two" })).rejects.toThrow(/revision/i);
    await f.bridge.drain();
    expect(f.facade.continueMessage).toHaveBeenCalledTimes(1);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    f.bridge.dispose();
  });
  it("keeps unsupported busy input queued and cancels without native send", async () => {
    const f = fixture(); f.state.status = "busy"; f.state.canDeliver = false;
    expect((await f.bridge.sendMessage(message)).status).toBe("queued");
    await f.bridge.drain();
    expect(f.facade.continueMessage).not.toHaveBeenCalled();
    expect((await f.bridge.cancelMessage("root", "input-one"))?.status).toBe("cancelled");
    f.bridge.dispose();
  });
  it("does not replay fenced work after a lost ACK and restart", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("unknown");
    f.bridge.dispose();
    const restored = fixture(f.saved);
    expect((await restored.bridge.sendMessage(message)).status).toBe("unknown");
    await restored.bridge.drain(); expect(restored.facade.continueMessage).not.toHaveBeenCalled();
    expect((await restored.bridge.conversation("root")).canChangeSelection).toBe(false);
    restored.bridge.dispose();
  });
  it("rejects arbitrary native session ids", async () => {
    const f = fixture(); await expect(f.bridge.conversation("native-one")).rejects.toThrow("Unknown owned task"); f.bridge.dispose();
  });
  it("holds native descendants after the initial parent turn finished and stops only the real ownership tree", async () => {
    const f = fixture();
    f.branches.push(
      { id: "child", title: "Child", parentEngine: "codex", parentSessionId: "native-one", parentWorkspacePath: "G:/project", engine: "codex", sessionId: "child-session", workspacePath: "G:/member", state: "completed" },
      { id: "grandchild", title: "Grandchild", parentEngine: "codex", parentSessionId: "child-session", parentWorkspacePath: "G:/member", engine: "codex", sessionId: "grandchild-session", workspacePath: "G:/member", state: "running" },
      { id: "unrelated", title: "Other", parentEngine: "codex", parentSessionId: "native-one", parentWorkspacePath: "G:/other", engine: "codex", sessionId: "other-session", workspacePath: "G:/other", state: "running" },
    );
    const snapshot = await f.bridge.conversation("root");
    expect(snapshot.children.map(c => c.id)).toEqual(["child", "grandchild"]);
    expect(snapshot.canChangeSelection).toBe(false); expect(snapshot.status).toBe("running");
    const stopping = await f.bridge.stopConversation("root");
    expect(f.facade.stopChild).toHaveBeenCalledExactlyOnceWith({ engine: "codex", sessionId: "child-session", workspacePath: "G:/member" }, "grandchild");
    expect(stopping.status).toBe("stopping");
    f.branches[1].state = "stopped";
    expect((await f.bridge.conversation("root")).status).toBe("cancelled");
    f.bridge.dispose();
  });
  it("uses a native turn_complete for a received live input, with identity and sequence checks", async () => {
    const f = fixture();
    await f.bridge.ready();
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 8, data: {}, ts: 100 }]);
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "other", kind: "turn_complete", seq: 9, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 8, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 10, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("completed");
    f.bridge.dispose();
  });
  it("never treats a finished run as proof that an unknown input arrived", async () => {
    const f = fixture();
    f.facade.continueMessage.mockImplementationOnce(async (_r, _p, _i, run, fence) => { await fence("turn", run); throw new Error("lost ACK"); });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.proofs.set("follow-run", { status: "completed" });
    f.events([{ runId: "follow-run", engine: "codex", sessionId: "native-one", kind: "turn_complete", seq: 10, data: {}, ts: 100 }]);
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("unknown");
    expect((await f.bridge.stopConversation("root")).status).toBe("unknown");
    f.bridge.dispose();
  });
  it("persists acceptance and delivery fences before acknowledging or calling native", async () => {
    const f = fixture();
    const original = f.facade.continueMessage.getMockImplementation()!;
    f.facade.continueMessage.mockImplementationOnce(async (...args) => {
      const disk = f.saved.get("__host_tasks_v1:conversations") as any;
      expect(disk.records[0].inputs[0].receipt.status).toBe("queued");
      const fence = args[4]; args[4] = async (delivery: string, run: string) => {
        await fence(delivery, run);
        expect((f.saved.get("__host_tasks_v1:conversations") as any).records[0].inputs[0].receipt.status).toBe("starting");
      };
      return original(...args);
    });
    await f.bridge.sendMessage(message); await f.bridge.drain(); f.bridge.dispose();
  });
  it("rejects stale displayed actions and freezes stable native row projections", async () => {
    const f = fixture();
    const a = await f.bridge.conversation("root"); const b = await f.bridge.conversation("root");
    expect(a).toBe(b); expect(a.messages[0]).toBe(b.messages[0]); expect(a.messages[0]).not.toBe(f.state.messages[0]);
    expect(Object.isFrozen(a.messages[0])).toBe(true);
    f.state.messages = [...f.state.messages, { seq: 2, role: "assistant", text: "中文😀", ts: null }];
    await expect(f.bridge.conversationAction("root", { type: "openNative", conversationRequestId: "root", expectedRevision: a.revision })).rejects.toThrow("Stale");
    expect(f.facade.conversationAction).not.toHaveBeenCalled();
    const c = await f.bridge.conversation("root"); expect(c.messages[0]).toBe(a.messages[0]);
    await expect(f.bridge.conversationAction("root", { type: "openNative", conversationRequestId: "other-source", expectedRevision: c.revision })).rejects.toThrow("Stale");
    await f.bridge.conversationAction("root", { type: "openNative", conversationRequestId: "root", expectedRevision: c.revision });
    expect(f.facade.conversationAction).toHaveBeenCalledOnce(); f.bridge.dispose();
  });
  it("keeps a queued input bounded and serializes simultaneous CAS acceptance", async () => {
    const f = fixture(); f.state.canDeliver = false;
    const results = await Promise.allSettled([f.bridge.sendMessage(message), f.bridge.sendMessage({ ...message, requestId: "rival" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (let i = 1; i < 32; i++) await f.bridge.sendMessage({ ...message, requestId: `input-${i}`, expectedInputRevision: i });
    await expect(f.bridge.sendMessage({ ...message, requestId: "overflow", expectedInputRevision: 32 })).rejects.toThrow("limit");
    expect(f.facade.continueMessage).not.toHaveBeenCalled(); f.bridge.dispose();
  });
  it("cancels pending input while preparation is awaiting and never resurrects it", async () => {
    const f = fixture(); let resolve!: (paths: string[]) => void;
    f.deps.resolveImages = () => new Promise<string[]>(r => { resolve = r; });
    await f.bridge.sendMessage(message);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const stopped = await f.bridge.stopConversation("root");
    expect(stopped.deliveries[0].status).toBe("cancelled");
    resolve([]); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("cancelled");
    expect((await f.bridge.conversation("root")).status).toBe("cancelled"); f.bridge.dispose();
  });
  it("requests stop immediately and again after a late native ACK without claiming terminal early", async () => {
    const f = fixture(); let acknowledge!: () => void;
    f.facade.continueMessage.mockImplementationOnce(async (_ref, _text, _images, run, fence) => {
      await fence("turn", run); f.state.runId = run; f.state.status = "busy"; f.state.canDeliver = false;
      await new Promise<void>(r => { acknowledge = r; }); return { delivery: "turn", runId: run };
    });
    await f.bridge.sendMessage(message); await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    const stopping = await f.bridge.stopConversation("root");
    expect(stopping.status).not.toBe("cancelled"); expect(f.facade.interrupt).toHaveBeenCalledWith("follow-run");
    acknowledge(); await f.bridge.drain();
    expect(f.facade.interrupt).toHaveBeenCalledTimes(2);
    expect((await f.bridge.conversation("root")).status).toBe("stopping");
    f.proofs.set("follow-run", { status: "cancelled" }); f.state.runId = null; f.state.status = "idle";
    expect((await f.bridge.conversation("root")).status).toBe("cancelled"); f.bridge.dispose();
  });
  it("refuses durable acceptance when storage fails and returns no false queued acknowledgement on retry", async () => {
    const f = fixture(); await f.bridge.conversation("root");
    f.deps.storage.set = async () => { throw new Error("disk failed"); };
    await expect(f.bridge.sendMessage(message)).rejects.toThrow(/persistence/i);
    expect((await f.bridge.sendMessage(message)).status).toBe("unknown");
    expect(f.facade.continueMessage).not.toHaveBeenCalled(); f.bridge.dispose();
  });
  it("recovers a checkpoint's original input IDs and received native settlement", async () => {
    const f = fixture(); await f.bridge.sendMessage(message); await f.bridge.drain();
    const cut = f.bridge.capture(); f.bridge.dispose();
    const next = fixture(); next.proofs.set("follow-run", { status: "completed" }); next.bridge.restore(cut);
    const receipt = await next.bridge.messageReceipt("root", "input-one");
    expect(receipt).toMatchObject({ status: "completed", runId: "follow-run", inputRevision: 1 });
    expect(next.facade.continueMessage).not.toHaveBeenCalled(); next.bridge.dispose();
  });
  it("rejects a corrupted persistent input fingerprint instead of dispatching it", async () => {
    const f = fixture(); f.state.canDeliver = false; await f.bridge.sendMessage(message);
    const cut = f.bridge.capture(); f.bridge.dispose(); cut.records[0].inputs[0].prompt = "forged";
    const next = fixture(); expect(() => next.bridge.restore(cut)).toThrow("input fence"); next.bridge.dispose();
  });
  it("accepts an explicit new same-session input after native stop has really settled", async () => {
    const f = fixture();
    expect(await f.bridge.stopConversation("root")).toMatchObject({ status: "cancelled", canSend: true });
    await f.bridge.sendMessage(message); await f.bridge.drain();
    expect((await f.bridge.messageReceipt("root", "input-one"))?.status).toBe("received");
    expect(f.facade.continueMessage.mock.calls[0][0]).toEqual(f.ref); f.bridge.dispose();
  });
  it("reports a proven native failure while keeping the same idle session available for an explicit new input", async () => {
    const f = fixture();
    await f.bridge.sendMessage(message); await f.bridge.drain();
    f.proofs.set("follow-run", { status: "failed" }); f.state.runId = null; f.state.status = "idle"; f.state.canDeliver = true;
    expect(await f.bridge.conversation("root")).toMatchObject({ status: "failed", canSend: true, canChangeSelection: true });
    await f.bridge.sendMessage({ ...message, requestId: "explicit-next", expectedInputRevision: 1 });
    expect((await f.bridge.messageReceipt("root", "explicit-next"))?.sessionRef).toEqual(f.ref); f.bridge.dispose();
  });
  it("does not enter native delivery if the owner disappears while the fence is persisting", async () => {
    const f = fixture(); const write = f.deps.storage.set;
    let release!: () => void; let nativeSent = false;
    f.deps.storage.set = async (owner, key, value) => {
      await write(owner, key, value);
      if ((value as any)?.records?.[0]?.inputs?.[0]?.receipt.status === "starting") await new Promise<void>(r => { release = r; });
    };
    f.facade.continueMessage.mockImplementationOnce(async (_ref, _text, _images, run, fence) => {
      await fence("turn", run); nativeSent = true; return { delivery: "turn", runId: run };
    });
    await f.bridge.sendMessage(message); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.bridge.dispose(); release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(nativeSent).toBe(false);
    const restored = fixture(f.saved);
    expect((await restored.bridge.messageReceipt("root", "input-one"))?.status).toBe("unknown");
    expect(restored.facade.continueMessage).not.toHaveBeenCalled(); restored.bridge.dispose();
  });
});
