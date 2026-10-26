import { describe, expect, it, vi } from "vitest";
import { createHostConversationBridge } from "./conversation-bridge";
import type { HostConversationFacade } from "./conversation-facade";
import type { SidechatState } from "@/features/sidechat/store";
const nativeId = "12345678-1234-1234-1234-123456789abc";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const records = new Map<string, unknown>();
  const states = new Map<string, SidechatState>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((f) => f());
  const storage = { get: vi.fn(async (_: string, key: string) => records.get(key)),
    set: vi.fn(async (_: string, key: string, value: unknown) => { records.set(key, structuredClone(value)); }), delete: vi.fn() };
  const facade: HostConversationFacade = {
    openFile: vi.fn(async () => {}),
    claim: vi.fn(async () => {}),
    resolveSelection: vi.fn(async (_plugin, selection) => ({ ...selection })),
    resolveImages: vi.fn(async (_plugin: string, ids: readonly string[]) => ids.map((id: string) => `C:/pasted/${id}.png`)),
    catalog: async () => ({ capabilities: { images: true, fixedInstructions: true }, engines: [{ id: "claude", label: "Claude", available: true, supportsImages: true, models: [{ id: "model", label: "Model" }],
      providers: [{ id: "provider", label: "Provider" }], defaultModel: "model", defaultEffort: "high", defaultProviderId: "provider" }],
      workspaces: [{ id: "w", path: "C:/work", name: "Work" }] }),
    workspace: async (path) => { if (path !== "C:/work") throw new Error("not registered"); return path; },
    read: (key) => states.get(key), restore: (key, state) => { states.set(key, state); },
    send: vi.fn(async (key, workspacePath, selection, prompt, runId, images) => {
      states.set(key, { open: true, mode: "read-only", engine: selection.engine, workspacePath,
        parentSessionId: null, sideSessionId: nativeId, runId, streaming: true, draft: "", error: null,
        usage: null, startedAt: 1, messages: [...(states.get(key)?.messages ?? []), { seq: (states.get(key)?.messages.at(-1)?.seq ?? 0) + 1, role: "user", text: prompt, ...(images && images.length > 0 ? { images } : {}), ts: "now" }] });
      notify();
    }),
    stop: vi.fn(async () => {}),
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const factory = vi.fn(async () => facade);
  const blockers: Array<() => readonly string[]> = [];
  const create = () => createHostConversationBridge("test", storage, { facade: factory,
    checkpoint: { assertAllowed() {}, registerBlocker: (_id, read) => { blockers.push(read); return () => {}; } } });
  const api = create();
  const open = () => api.open({ threadId: "one", workspacePath: "C:/work", selection: { engine: "claude" } });
  const request = { threadId: "one", requestId: "r1", expectedRevision: 0, prompt: "hello" };
  const finish = () => { for (const [key, s] of states) states.set(key, { ...s, streaming: false, runId: null }); notify(); };
  const record = () => [...records.values()][0] as { snapshot: { status: string; revision: number; sessionRef: { sessionId: string } | null }; state?: SidechatState; pendingUser?: { text: string }; launchSelection: unknown; memoryFloorSeq?: number };
  const settled = (status = "completed") => vi.waitFor(() => { expect(record().snapshot.status).toBe(status); expect(blockers[0]()).toEqual([]); });
  return { api, create, open, request, storage, records, states, facade, finish, notify, factory, blockers, record, settled };
}
describe("host conversations", () => {
  it("persists fixed guidance before each launch, restores it cold, and fingerprints updates separately from user text", async () => {
    const f = fixture(); await f.open();
    const v1 = { version: "discussion-v1", text: "Keep the user's independent judgement. 中文😀" };
    const v2 = { version: "discussion-v2", text: "Updated discussion policy." };
    const original = f.facade.send;
    vi.spyOn(f.facade, "send").mockImplementation(async (...args) => {
      expect((f.record() as any).fixedInstructions).toEqual(v1);
      expect(args[3]).toBe("hello");
      return original(...args);
    });
    await f.api.send({ ...f.request, fixedInstructions: v1 });
    await expect(f.api.send({ ...f.request, fixedInstructions: v2 })).rejects.toThrow("different input");
    f.finish(); await f.settled(); f.states.clear();
    const cold = f.create(); expect((await cold.inspect("one")).messages).toHaveLength(1);
    await cold.send({ ...f.request, requestId: "resumed", expectedRevision: 1 });
    expect((f.record() as any).fixedInstructions).toEqual(v1);
    f.finish(); await f.settled();
    vi.mocked(f.facade.send).mockImplementation(original);
    await cold.send({ ...f.request, requestId: "updated", expectedRevision: 2, fixedInstructions: v2 });
    expect((f.record() as any).fixedInstructions).toEqual(v2);
    expect((f.record() as any).fingerprint).toContain("discussion-v2");
    expect(f.facade.send).toHaveBeenCalledTimes(3);
    expect((await cold.inspect("one")).messages.map((m: any) => m.text)).toEqual(["hello", "hello", "hello"]);
    f.finish();
  });
  it("does not accept shortened prompts with instructions when the native channel is unavailable", async () => {
    const f = fixture(); await f.open(); const catalog = await f.facade.catalog();
    catalog.capabilities!.fixedInstructions = false; vi.spyOn(f.facade, "catalog").mockResolvedValue(catalog);
    await expect(f.api.send({ ...f.request, fixedInstructions: { version: "v1", text: "policy" } })).rejects.toThrow("unavailable");
    expect((await f.api.inspect("one")).revision).toBe(0); expect(f.facade.send).not.toHaveBeenCalled();
  });
  for (const status of ["failed", "cancelled"] as const) it(`retains ${status} rows but fences them out of later background extraction`, async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request);
    const [key, state] = [...f.states.entries()][0];
    f.states.set(key, { ...state, messages: [...state.messages, { seq: 2, role: "assistant", text: "unfinished proposal", ts: null }], error: status === "failed" ? "fixture failure" : null });
    if (status === "cancelled") await f.api.stop("one");
    f.finish(); await f.settled(status);
    expect(f.record().memoryFloorSeq).toBe(2);
    await f.api.send({ ...f.request, requestId: "r2", expectedRevision: 1, prompt: "new successful turn" });
    f.finish(); await f.settled();
    expect(f.record().memoryFloorSeq).toBe(2);
    expect(f.record().state?.messages.map(row => row.text)).toContain("unfinished proposal");
    f.states.clear(); const restored = await f.create().inspect("one");
    expect(restored.status).toBe("completed");
    expect(restored.messages).toHaveLength(3);
    expect(f.record().memoryFloorSeq).toBe(2);
  });
  it("rejects a second window before reading storage or launching", async () => {
    const f = fixture(); vi.mocked(f.facade.claim).mockRejectedValue(new Error("another open window"));
    await expect(f.open()).rejects.toThrow("another open window");
    await expect(f.api.send(f.request)).rejects.toThrow("another open window");
    expect(f.storage.get).not.toHaveBeenCalled(); expect(f.facade.send).not.toHaveBeenCalled();
  });
  it("retries failed facade initialization and storage reads without discarding accepted revisions", async () => {
    const f = fixture(); f.factory.mockRejectedValueOnce(new Error("initialization unavailable"));
    await expect(f.open()).rejects.toThrow("initialization");
    f.storage.get.mockRejectedValueOnce(new Error("read unavailable"));
    await expect(f.open()).rejects.toThrow("read unavailable");
    await f.open(); await f.api.send(f.request); f.finish(); await f.settled();
    f.states.clear(); const cold = f.create(); f.storage.get.mockRejectedValueOnce(new Error("read unavailable"));
    await expect(cold.inspect("one")).rejects.toThrow("read unavailable");
    expect((await cold.inspect("one")).revision).toBe(1);
    await expect(cold.send({ ...f.request, requestId: "old" })).rejects.toThrow("Stale");
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it("saves user intent before invocation without injecting a duplicate native row", async () => {
    const f = fixture(); await f.open();
    const original = f.facade.send;
    vi.spyOn(f.facade, "send").mockImplementation(async (...args) => {
      expect(f.record().pendingUser?.text).toBe("hello");
      expect(f.states.size).toBe(0);
      expect(f.record().snapshot.status).toBe("starting");
      return original(...args);
    });
    await f.api.send(f.request);
    expect(f.record().state?.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(f.record().pendingUser).toBeUndefined();
  });
  it("coalesces same request while native selection validation is pending", async () => {
    const f = fixture(); await f.open(); const wait = deferred();
    vi.mocked(f.facade.resolveSelection).mockImplementationOnce(async (_p, s) => { await wait.promise; return s; });
    const first = f.api.send(f.request);
    await vi.waitFor(() => expect(f.facade.resolveSelection).toHaveBeenCalledTimes(2));
    const second = f.api.send(f.request);
    await expect(f.api.send({ ...f.request, requestId: "other" })).rejects.toThrow("busy");
    wait.resolve(); const snapshots = await Promise.all([first, second]);
    expect(snapshots[0].revision).toBe(1); expect(snapshots[1].revision).toBe(1);
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it("retains a cold first-start user intent without inventing native state", async () => {
    const f = fixture(); await f.open(); const start = deferred();
    vi.mocked(f.facade.send).mockImplementationOnce(async () => start.promise);
    const sending = f.api.send(f.request);
    await vi.waitFor(() => expect(f.facade.send).toHaveBeenCalledTimes(1));
    const cold = f.create(); const snapshot = await cold.inspect("one");
    expect(snapshot.status).toBe("unknown"); expect(snapshot.sessionRef).toBeNull();
    expect(snapshot.messages).toEqual([expect.objectContaining({ role: "user", text: "hello" })]);
    expect(f.states.size).toBe(0); expect(f.blockers.at(-1)!()).toEqual([]);
    await expect(cold.send({ ...f.request, requestId: "new", expectedRevision: 1 })).rejects.toThrow("unknown");
    start.resolve(); await sending;
  });
  it("keeps ACK-pending stop identity and projection consistent across cold restore", async () => {
    const f = fixture(); await f.open(); const ack = deferred(); const original = f.facade.send;
    vi.spyOn(f.facade, "send").mockImplementation(async (...args) => { await original(...args); await ack.promise; });
    const sending = f.api.send(f.request);
    await vi.waitFor(() => expect(f.record().snapshot.sessionRef?.sessionId).toBe(nativeId));
    const stopped = await f.api.stop("one");
    expect(stopped.status).toBe("running"); expect(f.record().state?.streaming).toBe(true);
    expect(f.record().state?.sideSessionId).toBe(f.record().snapshot.sessionRef?.sessionId);
    ack.resolve(); await sending;
    f.states.clear(); const cold = f.create();
    const recovered = await cold.inspect("one");
    expect(recovered.status).toBe("unknown"); expect(recovered.messages).toHaveLength(1);
    expect(recovered.sessionRef?.sessionId).toBe(nativeId); expect(f.blockers.at(-1)!()).toEqual([]);
  });
  it("persists streaming projection with bounded coalescing and immediately flushes terminal", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request);
    const before = f.storage.set.mock.calls.length;
    const [key, initial] = [...f.states.entries()][0];
    for (let n = 1; n <= 200; n++) {
      f.states.set(key, { ...initial, messages: [...initial.messages, { seq: 2, role: "assistant", text: "字😀".repeat(n), ts: null, live: true }] }); f.notify();
    }
    await vi.waitFor(() => expect(f.record().state?.messages.at(-1)?.text).toBe("字😀".repeat(200)));
    expect(f.storage.set.mock.calls.length - before).toBe(1);
    const saved = f.storage.set.mock.calls.length;
    for (let n = 0; n < 20; n++) f.notify();
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(f.storage.set).toHaveBeenCalledTimes(saved);
    f.states.set(key, { ...f.states.get(key)!, messages: [...initial.messages, { seq: 2, role: "assistant", text: "final tail", ts: null }] });
    f.finish(); await f.settled();
    expect(f.record().state?.messages.at(-1)?.text).toBe("final tail");
  });
  it("a failed streaming save still blocks on the exact native run until terminal proof", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request);
    f.storage.set.mockRejectedValueOnce(new Error("disk"));
    const [key, state] = [...f.states.entries()][0];
    f.states.set(key, { ...state, messages: [...state.messages, { seq: 2, role: "assistant", text: "partial", ts: null }] }); f.notify();
    await vi.waitFor(async () => expect((await f.api.inspect("one")).status).toBe("unknown"));
    expect(f.blockers[0]()).not.toEqual([]);
    await f.api.stop("one"); expect(f.facade.stop).toHaveBeenCalledWith(key, state.runId);
    expect(f.blockers[0]()).not.toEqual([]);
    f.finish(); await f.settled("cancelled");
    expect(f.record().state?.messages.at(-1)?.text).toBe("partial");
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "wrong-id", "malformed"])("rejects %s host state before a resumed send", async (kind) => {
    const f = fixture(); await f.open(); await f.api.send(f.request); f.finish(); await f.settled();
    const [key, state] = [...f.states.entries()][0];
    if (kind === "missing") f.states.clear();
    else if (kind === "wrong-id") f.states.set(key, { ...state, sideSessionId: "invalid" });
    else f.states.set(key, { ...state, messages: [{ text: "bad" } as never] });
    await expect(f.api.send({ ...f.request, requestId: "next", expectedRevision: 1 })).rejects.toThrow();
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it("refuses a completed record with identity but no state", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request); f.finish(); await f.settled();
    delete f.record().state; f.states.clear();
    await expect(f.create().inspect("one")).rejects.toThrow("state is missing");
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it.each(["defaultModel", "defaultEffort"] as const)("requires explicit choices when %s is missing", async (field) => {
    const f = fixture(); const catalog = await f.facade.catalog(); catalog.engines[0][field] = null;
    vi.spyOn(f.facade, "catalog").mockResolvedValue(catalog);
    await expect(f.open()).rejects.toThrow("Explicit launch selection");
    expect(f.facade.resolveSelection).not.toHaveBeenCalled(); expect(f.facade.send).not.toHaveBeenCalled();
  });
  it("launches the native-resolved model and rejects later alias mapping drift", async () => {
    const f = fixture(); vi.mocked(f.facade.resolveSelection).mockImplementation(async (_p, s) => ({ ...s, model: "claude-exact-v1" }));
    expect((await f.open()).effectiveSelection.model).toBe("claude-exact-v1");
    await f.api.send(f.request); f.finish(); await f.settled();
    expect(f.facade.send).toHaveBeenCalledWith(expect.any(String), "C:/work", expect.objectContaining({ model: "claude-exact-v1" }), "hello", expect.any(String));
    expect(f.facade.resolveSelection).toHaveBeenLastCalledWith("test", { engine: "claude", model: "model", effort: "high", providerId: "provider" });
    vi.mocked(f.facade.resolveSelection).mockImplementation(async (_p, s) => ({ ...s, model: "claude-exact-v2" }));
    await expect(f.api.send({ ...f.request, requestId: "r2", expectedRevision: 1 })).rejects.toThrow("new thread");
    expect(f.facade.send).toHaveBeenCalledTimes(1); expect((await f.api.inspect("one")).revision).toBe(1);
  });
  it.each([{ model: "opus" }, { engine: "codex" }, { providerId: "other" }, { effort: "" }])("rejects invalid native resolution %j", async (patch) => {
    const f = fixture(); vi.mocked(f.facade.resolveSelection).mockImplementation(async (_p, s) => ({ ...s, ...patch } as typeof s));
    await expect(f.open()).rejects.toThrow(); expect(f.facade.send).not.toHaveBeenCalled();
  });
  it("durably reserves once, coalesces same ID, rejects competing IDs without interruption", async () => {
    const f = fixture(); await f.open();
    const wait = deferred(); f.storage.set.mockImplementationOnce(async () => wait.promise);
    const send = f.api.send(f.request);
    await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalledTimes(2));
    expect(f.facade.send).not.toHaveBeenCalled();
    expect((await f.api.send(f.request)).status).toBe("starting");
    await expect(f.api.send({ ...f.request, requestId: "r2" })).rejects.toThrow("busy");
    expect(f.facade.stop).not.toHaveBeenCalled();
    wait.resolve(); expect((await send).status).toBe("running");
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it("does not invoke native when the starting record fails", async () => {
    const f = fixture(); await f.open(); f.storage.set.mockRejectedValueOnce(new Error("disk"));
    await expect(f.api.send(f.request)).rejects.toThrow("persistence");
    expect(f.facade.send).not.toHaveBeenCalled();
    expect((await f.api.inspect("one")).status).toBe("unknown");
  });
  it("stop during durable preparation prevents invocation", async () => {
    const f = fixture(); await f.open(); const wait = deferred();
    f.storage.set.mockImplementationOnce(async () => wait.promise);
    const send = f.api.send(f.request);
    await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalledTimes(2));
    const stop = f.api.stop("one"); await Promise.resolve(); await Promise.resolve();
    wait.resolve(); await Promise.all([send, stop]);
    expect(f.facade.send).not.toHaveBeenCalled();
    expect((await f.api.inspect("one")).status).toBe("cancelled");
    expect((await f.api.inspect("one")).messages).toEqual([]);
  });
  it("terminal durability failure fences the thread", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request);
    f.storage.set.mockRejectedValueOnce(new Error("disk")); f.finish();
    await vi.waitFor(async () => expect((await f.api.inspect("one")).status).toBe("unknown"));
    await expect(f.api.send({ ...f.request, requestId: "r2", expectedRevision: 1 })).rejects.toThrow("unknown");
  });
  it.each(["completed", "failed", "cancelled"] as const)("publishes %s after a pending progress write drains without requiring another native event", async (status) => {
    const f = fixture(); await f.open(); await f.api.send(f.request);
    const events: Array<{ status: string; messages: unknown[] }> = [];
    f.api.onEvent(snapshot => events.push(snapshot));
    const gate = deferred(), entered = vi.fn();
    const originalSet = f.storage.set.getMockImplementation()!;
    f.storage.set.mockImplementationOnce(async (...args) => { entered(); await gate.promise; await originalSet(...args); });
    const [key, state] = [...f.states.entries()][0];
    const answer = "完整中文🌏回答。\n\n```txt\n没有丢字\n```";
    f.states.set(key, { ...state, draft: "下一条消息仍在编辑👩🏽‍💻", messages: [...state.messages, { seq: 2, role: "assistant", text: answer, ts: "now", live: true }] });
    f.notify();
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      const stop = status === "cancelled" ? f.api.stop("one") : Promise.resolve();
      if (status === "cancelled") await vi.waitFor(() => expect(f.facade.stop).toHaveBeenCalledOnce());
      const latest = f.states.get(key)!;
      f.states.set(key, { ...latest, error: status === "failed" ? "fixture native failure" : null, messages: latest.messages.map(row => ({ ...row, live: false })) });
      f.finish();
      gate.resolve(); await stop; await f.settled(status);
      expect((await f.api.inspect("one")).status).toBe(status);
      expect(events.at(-1)?.status).toBe(status);
      expect(events.at(-1)?.messages).toEqual(f.states.get(key)!.messages);
      expect(f.states.get(key)!.draft).toBe("下一条消息仍在编辑👩🏽‍💻");
      expect(f.facade.send).toHaveBeenCalledTimes(1);
      expect(f.blockers[0]()).toEqual([]);
    } finally { gate.resolve(); }
  });
  it("retains only latest request and rejects stale replay after another turn", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request); f.finish();
    await f.settled();
    await f.api.send({ ...f.request, requestId: "r2", expectedRevision: 1 });
    f.finish(); await f.settled();
    await expect(f.api.send(f.request)).rejects.toThrow("Stale");
    expect(f.records.size).toBe(1);
    expect((await f.api.inspect("one")).lastRequestId).toBe("r2");
  });
  it("restores unresolved runs as unknown and never resends", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request);
    f.states.clear();
    const restored = f.create();
    expect((await restored.inspect("one")).status).toBe("unknown");
    await expect(restored.send({ ...f.request, requestId: "r2", expectedRevision: 1 })).rejects.toThrow("unknown");
    expect(f.facade.send).toHaveBeenCalledTimes(1);
  });
  it("restores terminal host messages and native session identity without replay", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request); f.finish();
    await f.settled();
    f.states.clear();
    const restored = f.create(); const snapshot = await restored.inspect("one");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.sessionRef).toEqual({ engine: "claude", sessionId: nativeId, workspacePath: "C:/work" });
    expect(snapshot.messages).toHaveLength(1);
    expect(f.facade.send).toHaveBeenCalledTimes(1);
    await restored.send({ ...f.request, expectedRevision: 1, requestId: "r2" });
    expect(f.facade.send).toHaveBeenCalledTimes(2);
  });
  it("rejects tampered persisted ownership before restoring native state", async () => {
    const f = fixture(); await f.open(); await f.api.send(f.request); f.finish();
    await f.settled();
    const record = [...f.records.values()][0] as { state: SidechatState };
    record.state.parentSessionId = "different-parent";
    f.states.clear();
    await expect(f.create().inspect("one")).rejects.toThrow("ownership mismatch");
    expect(f.states.size).toBe(0);
  });
  it("disposal removes UI listeners without stopping the native session", async () => {
    const f = fixture(); await f.open(); const cb = vi.fn(); f.api.onEvent(cb);
    await f.api.send(f.request); cb.mockClear(); f.api.dispose(); f.finish();
    await f.settled();
    expect(cb).not.toHaveBeenCalled(); expect(f.facade.stop).not.toHaveBeenCalled();
  });
  it("freezes selection, rejects unknown fields and scopes, returns detached message copies", async () => {
    const f = fixture(); await f.open();
    await expect(f.api.open({ threadId: "one", workspacePath: "C:/work", selection: { engine: "claude", model: "other" } })).rejects.toThrow("immutable");
    await expect(f.api.open({ threadId: "two", workspacePath: "C:/else", selection: { engine: "claude" } })).rejects.toThrow("registered");
    await expect(f.api.send({ ...f.request, execute: true } as never)).rejects.toThrow("fields");
    const snap = await f.api.send(f.request); snap.messages.length = 0;
    expect((await f.api.inspect("one")).messages).toHaveLength(1);
    expect(f.facade.send).toHaveBeenCalledWith(expect.any(String), "C:/work", { engine: "claude", model: "model", effort: "high", providerId: "provider" }, "hello", expect.stringMatching(/^sidechat-/));
  });
  it("supports image-only and multimodal sends, fingerprints image order, and rejects invalid/unsupported images before durable save", async () => {
    const f = fixture(); await f.open();
    await expect(f.api.send({ ...f.request, prompt: "   " })).rejects.toThrow("Invalid conversation send");
    await expect(f.api.send({ ...f.request, images: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] })).rejects.toThrow("Invalid conversation send images");
    vi.mocked(f.facade.resolveImages!).mockRejectedValueOnce(new Error("Unknown plugin image attachment"));
    await expect(f.api.send({ ...f.request, images: ["bad-img"] })).rejects.toThrow("Unknown plugin image");
    expect((await f.api.inspect("one")).status).toBe("idle");

    const catalog = await f.facade.catalog();
    catalog.engines[0].supportsImages = false;
    vi.spyOn(f.facade, "catalog").mockResolvedValueOnce(catalog);
    await expect(f.api.send({ ...f.request, images: ["img-1"] })).rejects.toThrow("does not support image");
    expect((await f.api.inspect("one")).status).toBe("idle");

    const imgReq = { ...f.request, prompt: "   ", images: ["img-1", "img-2"] };
    const snap = await f.api.send(imgReq);
    expect((snap.messages[0] as { images?: string[] }).images).toEqual(["C:/pasted/img-1.png", "C:/pasted/img-2.png"]);
    expect(f.facade.send).toHaveBeenCalledWith(
      expect.any(String),
      "C:/work",
      expect.objectContaining({ engine: "claude" }),
      "   ",
      expect.stringMatching(/^sidechat-/),
      ["C:/pasted/img-1.png", "C:/pasted/img-2.png"],
    );
    await expect(f.api.send({ ...imgReq, images: ["img-2", "img-1"] })).rejects.toThrow("different input");

    // Missing supportsImages (undefined) fails closed
    const catalogUndefined = await f.facade.catalog();
    delete (catalogUndefined.engines[0] as { supportsImages?: boolean }).supportsImages;
    vi.spyOn(f.facade, "catalog").mockResolvedValueOnce(catalogUndefined);
    f.finish();
    await f.settled();
    await expect(f.api.send({ ...f.request, requestId: "r-undef", expectedRevision: 1, images: ["img-1"] })).rejects.toThrow("does not support image");

    // Cold restore validates 3-tuple image-bearing fingerprint and rejects tampered fingerprint
    f.states.clear();
    const restored = f.create();
    expect((await restored.inspect("one")).status).toBe("completed");
    await expect(restored.send(imgReq)).resolves.toMatchObject({ revision: 1, lastRequestId: "r1" });
    await expect(restored.send({ ...imgReq, images: ["img-2", "img-1"] })).rejects.toThrow("different input");

    const rawRecord = [...f.records.values()][0] as { fingerprint: string };
    rawRecord.fingerprint = JSON.stringify([0, "   ", ["bad/id"]]);
    f.states.clear();
    await expect(f.create().inspect("one")).rejects.toThrow("identity mismatch");
  });
});
