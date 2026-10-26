import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostChatTarget, HostChatSession } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import { createRuntimeCheckpointCoordinator, type RuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { HostChatBusyError } from "@/features/chat/store/types";
import { createHostChatBridge, hostChatCheckpointId, type HostChatFacade } from "./chat-bridge";
import type { CorrespondenceEnvelope, CorrespondenceReceipt, InboxCaller, InboxParticipant } from "./chat-inbox";

const source: InboxParticipant = { engine: "codex", sessionId: "source-session", workspacePath: "G:/source" };
const recipient: InboxParticipant = { engine: "agy", sessionId: "recipient-session", workspacePath: "G:/recipient" };
const id = (digit: string) => `cross:${digit.repeat(64)}`;
const rootId = id("0");
const identity = { clientInstanceId: "inbox-desktop", windowId: "inbox-window" };
const targetOf = (participant: InboxParticipant): HostChatTarget => ({ client: "ccgui", ...identity, engine: participant.engine,
  nativeSessionId: participant.sessionId, guiSessionId: participant.sessionId, workspacePath: participant.workspacePath });
const target = targetOf(recipient);
const fixtures: Array<{ bridge: ReturnType<typeof createHostChatBridge> }> = [];
function checkpoint(snapshot?: RuntimeCheckpoint) { const c = createRuntimeCheckpointCoordinator(); c.initialize(snapshot, { requiredParticipants: [] }); return c; }
function fixture(data = new Map<string, unknown>(), coordinator = checkpoint()) {
  const observers = new Set<() => void>(); let receive: (events: EngineEventPayload[]) => void = () => {};
  const sessions = new Map<string, HostChatSession>([[recipient.sessionId, { ...target, status: "idle" }], [source.sessionId, { ...targetOf(source), status: "busy" }]]);
  const interrupted = new Set<string>();
  const backend = { get: vi.fn(async (_plugin: string, key: string) => structuredClone(data.get(key) ?? null)),
    set: vi.fn(async (_plugin: string, key: string, value: unknown) => { data.set(key, structuredClone(value)); }), delete: vi.fn(async () => {}) };
  const host: HostChatFacade = { identity, current: () => sessions.get(recipient.sessionId)!, model: () => "fixture-model",
    inspect: item => { const found = sessions.get(item.nativeSessionId); return found && found.engine === item.engine && found.workspacePath === item.workspacePath ? { ...found } : null; },
    send: vi.fn(async (item, _prompt, runId) => { sessions.set(item.nativeSessionId, { ...item, status: "busy" }); return { runId, sessionId: item.nativeSessionId }; }),
    subscribe: callback => { observers.add(callback); return () => { observers.delete(callback); }; }, wasInterrupted: item => interrupted.has(item.nativeSessionId) };
  const bridge = createHostChatBridge("inbox-tests", backend, { host: async () => host, listen: async callback => { receive = callback; return () => {}; }, checkpoint: coordinator });
  const f = { bridge, data, backend, host, sessions, interrupted, checkpoint: coordinator,
    idle(participant = recipient) { const t = targetOf(participant); sessions.set(participant.sessionId, { ...t, status: "idle" }); observers.forEach(cb => cb()); },
    emit(receipt: CorrespondenceReceipt, kind: EngineEventPayload["kind"], seq = 1, value: unknown = {}, runId = receipt.runId) {
      receive([{ runId, engine: receipt.target.engine, sessionId: receipt.target.nativeSessionId, kind, seq, data: value }]);
    } };
  fixtures.push(f); return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.bridge.ready().catch(() => {}); f.bridge.dispose(); } });
const originalEnvelope: CorrespondenceEnvelope = { sender: source, requestId: "original" };
async function original(f: ReturnType<typeof fixture>, busy = false) {
  if (busy) f.sessions.set(recipient.sessionId, { ...target, status: "busy" });
  const receipt = await f.bridge.submitCorrespondence({ requestId: rootId, target, prompt: "ORIGINAL REQUEST — do not replay" }, originalEnvelope);
  if (!busy) await vi.waitFor(async () => expect(await f.bridge.receipt(rootId)).toMatchObject({ status: "executing" }));
  return receipt;
}
function supplement(f: ReturnType<typeof fixture>, digit = "1", kind: CorrespondenceEnvelope["kind"] = "information", text = "补充原文 👩🏽‍💻") {
  return f.bridge.submitCorrespondence({ requestId: id(digit), target, prompt: text }, { sender: source, requestId: `update-${digit}`, kind,
    relation: { type: "update", requestId: "original", scopedId: rootId } });
}
const caller = (runId: string): InboxCaller => ({ ...recipient, runId });

describe("associated cross-chat inbox", () => {
  it("retrieves a busy turn's update without a new execution, preserves exact text and acknowledges once", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    expect(await f.bridge.inboxStatus(caller(root.runId))).toMatchObject({ pending: 1, needsReconciliation: 0 });
    const read = await f.bridge.readMessages(caller(root.runId), { requestId: "read-one" });
    expect(read.messages).toMatchObject([{ message_id: id("1"), message: "补充原文 👩🏽‍💻", read_request_id: "read-one", needs_reconciliation: false }]);
    expect(f.host.send).toHaveBeenCalledTimes(1);
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "read-one" })).messages).toEqual(read.messages);
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "read-two" })).messages).toEqual([]);
    const ack = { readRequestId: "read-one", outcome: "handled" as const, response: "已将补充纳入本轮，实际验收待完成。" };
    expect(await f.bridge.acknowledgeMessage(caller(root.runId), id("1"), ack)).toMatchObject({ status: "completed", mailbox: { phase: "handled" } });
    await expect(f.bridge.acknowledgeMessage(caller(root.runId), id("1"), ack)).resolves.toMatchObject({ status: "completed" });
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "read-one" })).messages[0].processing_state).toBe("handled");
    await expect(f.bridge.acknowledgeMessage(caller(root.runId), id("1"), { ...ack, response: "changed" })).rejects.toThrow("different outcome");
  });

  it("merges unread updates into a not-yet-started original request instead of scheduling another round", async () => {
    const f = fixture(), root = await original(f, true); await supplement(f); await supplement(f, "2");
    expect((await f.bridge.readMessages(caller("unrelated-active-turn"), { requestId: "before-original" })).messages).toEqual([]);
    f.idle(); await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(1));
    const prompt = vi.mocked(f.host.send).mock.calls[0][1];
    expect(prompt).toContain("ORIGINAL REQUEST"); expect(prompt).toContain(id("1")); expect(prompt).toContain(id("2"));
    f.emit(root, "delta", 1, "综合答复"); f.emit(root, "done", 2); f.idle();
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("2"))).toMatchObject({ status: "completed", mailbox: { phase: "handled" } }));
    expect(f.host.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a message arriving after the last empty inbox read for the next turn", async () => {
    const f = fixture(), root = await original(f);
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "last-tool-call" })).messages).toEqual([]);
    const update = await supplement(f);
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "last-tool-call" })).messages).toEqual([]);
    f.emit(root, "done"); f.idle();
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.host.send).mock.calls[1][2]).toBe(update.runId);
  });

  it("serializes an inbox retrieval write against turn completion without double delivery", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    const write = f.backend.set.getMockImplementation()!, gate = Promise.withResolvers<void>(); let entered = false;
    f.backend.set.mockImplementationOnce(async (...args) => { entered = true; await gate.promise; await write(...args); });
    const read = f.bridge.readMessages(caller(root.runId), { requestId: "overlap-end" });
    await vi.waitFor(() => expect(entered).toBe(true));
    f.emit(root, "done"); f.idle(); gate.resolve();
    expect((await read).messages).toHaveLength(1);
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } }));
    expect(f.host.send).toHaveBeenCalledTimes(1);
  });

  it("never claims for a run that finishes while read initialization yields", async () => {
    const f = fixture(), root = await original(f); const update = await supplement(f);
    const pending = f.bridge.readMessages(caller(root.runId), { requestId: "read-crossing-done" });
    f.emit(root, "done"); f.idle();
    expect((await pending).messages).toEqual([]);
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.host.send).mock.calls[1][2]).toBe(update.runId);
  });

  it("accounts for an accepted message whose persistence overlaps the final event", async () => {
    const f = fixture(), root = await original(f);
    const write = f.backend.set.getMockImplementation()!, gate = Promise.withResolvers<void>(); let entered = false;
    f.backend.set.mockImplementationOnce(async (...args) => { entered = true; await gate.promise; await write(...args); });
    const accepted = supplement(f);
    await vi.waitFor(() => expect(entered).toBe(true));
    f.emit(root, "done"); f.idle(); gate.resolve();
    const update = await accepted;
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.host.send).mock.calls[1][2]).toBe(update.runId);
    expect(await f.bridge.receipt(rootId)).toMatchObject({ status: "completed" });
  });

  it("never exposes the same unread message through a racing fallback launch and inbox read", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    f.emit(root, "done"); f.idle();
    const read = await f.bridge.readMessages(caller(root.runId), { requestId: "last-racing-read" });
    await f.bridge.ready();
    expect(read.messages.length + (vi.mocked(f.host.send).mock.calls.length - 1)).toBe(1);
  });

  it("leaves bounded unread messages pending rather than truncating or claiming omitted bodies", async () => {
    const f = fixture(), root = await original(f);
    for (const digit of ["1", "2", "3", "4"]) await supplement(f, digit, "information", `${digit}:` + "中文".repeat(12_000));
    const read = await f.bridge.readMessages(caller(root.runId), { requestId: "bounded-read", limit: 8 });
    expect(read.messages.length).toBeGreaterThan(0); expect(read.messages.length).toBeLessThan(4);
    for (const message of read.messages) expect(message.message.length).toBe(24_002);
    expect(read.inbox.pending).toBe(4 - read.messages.length);
    expect(new TextEncoder().encode(JSON.stringify(read)).length).toBeLessThan(1024 * 1024);
  });

  it.each(["before-end", "after-end"])("carries an unread %s update forward with its own identity and no original replay", async timing => {
    const f = fixture(), root = await original(f); let update: CorrespondenceReceipt;
    if (timing === "before-end") update = await supplement(f);
    f.emit(root, "done");
    await vi.waitFor(async () => expect(await f.bridge.receipt(rootId)).toMatchObject({ status: "completed" }));
    if (timing === "after-end") update = await supplement(f);
    f.idle(); await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    const call = vi.mocked(f.host.send).mock.calls[1];
    expect(call[2]).toBe(update!.runId); expect(call[1]).toContain("补充原文 👩🏽‍💻"); expect(call[1]).not.toContain("ORIGINAL REQUEST");
    f.emit(update!, "delta", 1, "针对补充的答复"); f.emit(update!, "done", 2); f.idle();
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "completed", mailbox: { phase: "handled" } }));
    expect(f.host.send).toHaveBeenCalledTimes(2);
  });

  it("coalesces unread supplements into one continuation while leaving the completed original receipt sealed", async () => {
    const f = fixture(), root = await original(f); const first = await supplement(f); await supplement(f, "2"); await supplement(f, "3");
    f.emit(root, "delta", 1, "原答复"); f.emit(root, "done", 2); f.idle();
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.host.send).mock.calls[1][1]).toContain(id("3"));
    f.emit(first, "delta", 1, "补充答复"); f.emit(first, "done", 2); f.idle();
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("3"))).toMatchObject({ status: "completed" }));
    expect(await f.bridge.receipt(rootId)).toMatchObject({ status: "completed", text: "原答复" });
    expect(f.host.send).toHaveBeenCalledTimes(2);
  });

  it.each(["done", "error"] as const)("keeps batch siblings pending after a single acknowledgement until native %s", async kind => {
    const f = fixture(), root = await original(f); const first = await supplement(f); await supplement(f, "2");
    f.emit(root, "done"); f.idle(); await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    const ack = { readRequestId: `turn-${first.runId}`, outcome: "handled" as const, response: "first only" };
    await f.bridge.acknowledgeMessage(caller(first.runId), id("1"), ack);
    expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "completed", text: "first only" });
    expect(await f.bridge.receipt(id("2"))).toMatchObject({ status: "executing", mailbox: { phase: "retrieved" } });
    f.emit(first, "delta", 1, "final batch response"); f.emit(first, kind, 2, kind === "error" ? "failed later" : {});
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("2"))).toMatchObject({ status: kind === "done" ? "completed" : "unknown",
      mailbox: { phase: kind === "done" ? "handled" : "uncertain" } }));
    expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "completed", text: "first only" });
    if (kind === "done") expect(await f.bridge.receipt(id("2"))).toMatchObject({ text: "final batch response" });
  });

  it("marks retrieved-but-unacknowledged work uncertain on turn end and never automatically replays it", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    await f.bridge.readMessages(caller(root.runId), { requestId: "read-before-end" });
    f.emit(root, "done"); f.idle();
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } }));
    expect(f.host.send).toHaveBeenCalledTimes(1);
    expect(await f.bridge.inboxStatus(caller("next-turn"))).toMatchObject({ pending: 0, needsReconciliation: 1 });
    const review = await f.bridge.readMessages(caller("next-turn"), { requestId: "review", messageIds: [id("1")] });
    expect(review.messages[0].needs_reconciliation).toBe(true);
    await expect(f.bridge.acknowledgeMessage(caller(root.runId), id("1"), { readRequestId: "read-before-end", outcome: "handled" })).rejects.toThrow("authenticated retrieval");
    f.emit(root, "done", 2);
    await expect(f.bridge.acknowledgeMessage(caller("next-turn"), id("1"), { readRequestId: "review", outcome: "handled", response: "查证原操作已生效，没有重复执行" })).resolves.toMatchObject({ status: "completed" });
  });

  it("requires impact review for a correction, including completed and still in-flight side effects", async () => {
    const f = fixture(), root = await original(f); await supplement(f, "1", "correction", "路径写错了，应该是 X");
    const read = await f.bridge.readMessages(caller(root.runId), { requestId: "correction" });
    expect(read.instructions).toContain("completed and in-flight tool results"); expect(read.instructions).toContain("do not perform a blanket rollback");
    await expect(f.bridge.acknowledgeMessage(caller(root.runId), id("1"), { readRequestId: "correction", outcome: "handled" })).rejects.toThrow("impact_review");
    await expect(f.bridge.acknowledgeMessage(caller(root.runId), id("1"), { readRequestId: "correction", outcome: "handled",
      impactReview: "已停止旧路径的后续写入，检查本轮已写文件与仍在执行的工具；保留他人改动，补偿后复验。" })).resolves.toMatchObject({ mailbox: { phase: "handled", impactReview: expect.stringContaining("仍在执行") } });
  });

  it("does not infer a correction's impact review from an otherwise successful final reply", async () => {
    const f = fixture(), root = await original(f); const update = await supplement(f, "1", "correction");
    f.emit(root, "done"); f.idle(); await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    f.emit(update, "delta", 1, "done"); f.emit(update, "done", 2); f.idle();
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } }));
    expect(f.host.send).toHaveBeenCalledTimes(2);
  });

  it("holds unread updates after a user stop until an explicit human queue action", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    f.interrupted.add(recipient.sessionId); f.emit(root, "done"); f.idle(); await f.bridge.ready();
    expect(f.host.send).toHaveBeenCalledTimes(1);
    expect(await f.bridge.receipt(id("1"))).toMatchObject({ mailbox: { phase: "received", waitReason: "stopped" } });
    await f.bridge.prioritize(id("1")); await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
  });

  it("binds inbox reads to exact recipient, engine, workspace and retrieval run", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    for (const wrong of [{ ...source, runId: root.runId }, { ...caller(root.runId), engine: "codex" }, { ...caller(root.runId), workspacePath: "G:/other" }]) {
      await expect(f.bridge.readMessages(wrong, { requestId: "wrong", messageIds: [id("1")] })).rejects.toThrow("caller");
    }
    await f.bridge.readMessages(caller(root.runId), { requestId: "correct" });
    await expect(f.bridge.acknowledgeMessage(caller("other-run"), id("1"), { readRequestId: "correct", outcome: "handled" })).rejects.toThrow("authenticated retrieval");
  });

  it("validates reply direction, relation ownership and retries without changing an accepted message", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    await expect(f.bridge.submitCorrespondence({ requestId: id("1"), target, prompt: "补充原文 👩🏽‍💻" }, {
      sender: source, requestId: "update-1", kind: "correction", relation: { type: "update", requestId: "original", scopedId: rootId },
    })).rejects.toThrow("different relation");
    await expect(f.bridge.submitCorrespondence({ requestId: id("2"), target, prompt: "wrong direction" }, {
      sender: source, requestId: "bad-reply", relation: { type: "reply", requestId: "original", scopedId: rootId },
    })).rejects.toThrow("different participants");
    await f.bridge.submitCorrespondence({ requestId: id("3"), target: targetOf(source), prompt: "这是原问题的关联答复" }, {
      sender: recipient, requestId: "reply", relation: { type: "reply", requestId: "original", scopedId: rootId },
    });
    const read = await f.bridge.readMessages({ ...source, runId: "source-waiting-run" }, { requestId: "read-reply" });
    expect(read.messages).toMatchObject([{ message_id: id("3"), relation: { type: "reply", request_id: "original" } }]);
    expect(f.host.send).toHaveBeenCalledTimes(1);
    expect(root.runId).toBeTruthy();
  });

  it("keeps approvals ahead of inbox retrieval and rechecks the model before exposure", async () => {
    const f = fixture(), root = await original(f);
    await f.bridge.submitCorrespondence({ requestId: id("1"), target, prompt: "held" }, { sender: source, requestId: "held", relation: { type: "update", requestId: "original", scopedId: rootId } }, { requiresCostApproval: true });
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "held-read" })).messages).toEqual([]);
    expect(await f.bridge.inboxStatus(caller(root.runId))).toMatchObject({ pending: 0, held: 1 });
    await f.bridge.approveCost(id("1"), "fixture-model");
    f.host.model = () => "changed-model";
    expect((await f.bridge.readMessages(caller(root.runId), { requestId: "changed-model" })).messages).toEqual([]);
    expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "awaiting_cost_approval" });
  });

  it("fences a retrieval whose durable write result is unknown without exposing or replaying its payload", async () => {
    const f = fixture(), root = await original(f); await supplement(f);
    const write = f.backend.set.getMockImplementation()!;
    f.backend.set.mockImplementationOnce(async (...args) => { await write(...args); throw new Error("lost storage ACK"); });
    await expect(f.bridge.readMessages(caller(root.runId), { requestId: "uncertain-read" })).rejects.toThrow("could not be confirmed");
    f.emit(root, "done"); f.idle(); await f.bridge.ready();
    expect(f.host.send).toHaveBeenCalledTimes(1);
    expect(await f.bridge.receipt(id("1"))).toMatchObject({ status: "unknown", mailbox: { phase: "uncertain" } });
  });

  it("restores a claimed inbox and read identity through a planned document handoff without redispatch", async () => {
    const old = fixture(), root = await original(old); await supplement(old);
    const read = await old.bridge.readMessages(caller(root.runId), { requestId: "preserved-read" });
    const snapshot = await old.checkpoint.prepare(); old.bridge.dispose();
    const next = fixture(old.data, checkpoint(snapshot)); next.sessions.set(recipient.sessionId, { ...target, status: "busy" });
    await next.bridge.ready(); await next.checkpoint.resume();
    expect((await next.bridge.readMessages(caller(root.runId), { requestId: "preserved-read" })).messages).toEqual(read.messages);
    await next.bridge.acknowledgeMessage(caller(root.runId), id("1"), { readRequestId: "preserved-read", outcome: "handled", response: "恢复后确认原处理" });
    expect(next.host.send).not.toHaveBeenCalled();
    expect(snapshot.participants[hostChatCheckpointId("inbox-tests")]).toBeTruthy();
  });

  it("rejects encoded payloads that cannot fit intact in a bounded MCP response before acceptance", async () => {
    const f = fixture(); await original(f);
    await expect(supplement(f, "1", "information", "\u0000".repeat(40_000))).rejects.toThrow("too large");
    expect(await f.bridge.receipt(id("1"))).toBeNull();
  });

  it("restores definitely unadmitted continuation claims when the native start reports busy", async () => {
    const f = fixture(), root = await original(f); await supplement(f); await supplement(f, "2");
    vi.mocked(f.host.send).mockImplementationOnce(async () => { f.sessions.set(recipient.sessionId, { ...target, status: "busy" }); throw new HostChatBusyError(); });
    f.emit(root, "done"); f.idle();
    await vi.waitFor(async () => expect(await f.bridge.receipt(id("2"))).toMatchObject({ mailbox: { phase: "received" } }));
    const read = await f.bridge.readMessages(caller("new-existing-turn"), { requestId: "after-busy" });
    expect(read.messages).toHaveLength(2);
  });
});
