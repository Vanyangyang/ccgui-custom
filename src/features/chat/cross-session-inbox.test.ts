import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostChatTarget, HostChatSession } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import { createRuntimeCheckpointCoordinator } from "@/lib/runtime-checkpoint";
import { createHostChatBridge, type HostChatFacade } from "@/features/plugins/runtime/chat-bridge";
import { createCrossSessionHandler, useCrossSessionActivityStore, type CrossSessionRequest } from "./cross-session";
import { EMPTY_SESSION } from "./store/stream";
import { sessionKey } from "./store/persistence";
import type { ChatStore } from "./store/types";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("./store", async () => ({ useChatStore: { getState: vi.fn(), subscribe: vi.fn(() => () => {}) }, sessionKey: (await import("./store/persistence")).sessionKey }));
const a = { engine: "codex", sessionId: "source-12345678", workspacePath: "G:/source" };
const b = { engine: "agy", sessionId: "target-12345678", workspacePath: "G:/target" };
const identity = { clientInstanceId: "inbox-integration", windowId: "inbox-integration-window" };
const targetOf = (participant: typeof a): HostChatTarget => ({ client: "ccgui", ...identity, ...participant, nativeSessionId: participant.sessionId, guiSessionId: participant.sessionId });
const disposers: Array<() => void> = [];
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); useCrossSessionActivityStore.getState().reset(); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });
function fixture() {
  const metas = [a, b].map(value => ({ ...value, title: value.sessionId, model: value.engine === "codex" ? "gpt-6-astra" : "gemini-fixture", promptCache: null } as SessionMeta));
  const state = { initialized: true, bySession: {}, sessions: metas, archivedSessionKeys: {}, openTabs: metas.map(meta => ({ engine: meta.engine, sessionId: meta.sessionId, workspacePath: meta.workspacePath, model: meta.model })), active: a, permission: "manual" } as unknown as ChatStore;
  for (const meta of metas) state.bySession[sessionKey(meta.engine, meta.sessionId, meta.workspacePath)] = { ...EMPTY_SESSION, messages: [], activeModel: meta.model,
    usage: meta.engine === "agy" ? { context_usage_kind: "current_context", context_usage: { input_tokens: 100 } } : { input_tokens: 100 } };
  state.selectSession = vi.fn(async () => {});
  const sessions = new Map<string, HostChatSession>([[a.sessionId, { ...targetOf(a), status: "busy" }], [b.sessionId, { ...targetOf(b), status: "idle" }]]);
  state.bySession[sessionKey(a.engine, a.sessionId, a.workspacePath)].streaming = true;
  const subscribers = new Set<() => void>(); let receive: (events: EngineEventPayload[]) => void = () => {};
  const host: HostChatFacade = { identity, current: () => sessions.get(a.sessionId)!, model: target => metas.find(meta => meta.sessionId === target.nativeSessionId)?.model ?? undefined,
    inspect: target => { const current = sessions.get(target.nativeSessionId); return current && current.engine === target.engine && current.workspacePath === target.workspacePath ? { ...current } : null; },
    send: vi.fn(async (target, _prompt, runId) => { sessions.set(target.nativeSessionId, { ...target, status: "busy" }); state.bySession[sessionKey(target.engine, target.nativeSessionId, target.workspacePath)].streaming = true; return { runId, sessionId: target.nativeSessionId }; }),
    subscribe: callback => { subscribers.add(callback); return () => { subscribers.delete(callback); }; }, wasInterrupted: () => false };
  const data = new Map<string, unknown>(), checkpoint = createRuntimeCheckpointCoordinator(); checkpoint.initialize(undefined, { requiredParticipants: [] });
  const bridge = createHostChatBridge("cross-inbox-integration", { get: async (_id, key) => data.get(key) ?? null, set: async (_id, key, value) => { data.set(key, structuredClone(value)); }, delete: async () => {} }, {
    host: async () => host, listen: async callback => { receive = callback; return () => {}; }, checkpoint,
  });
  disposers.push(bridge.dispose);
  const handler = createCrossSessionHandler({ bridge, store: { getState: () => state }, catalog: async () => ({ sessions: metas, archived: [], workspaces: [a, b].map(({ workspacePath }) => ({ path: workspacePath } as Workspace)) }) });
  function call(participant: typeof a, method: string, args: Record<string, unknown>, runId = `run-${participant.sessionId}`) {
    return handler({ requestId: "transport-fixture", sender: { ...participant, runId }, method, arguments: args } as CrossSessionRequest) as Promise<any>;
  }
  async function start() {
    const root = await call(a, "send_message", { request_id: "original", session_id: b.sessionId, message: "请核对这个问题", wait_seconds: 0 });
    await vi.waitFor(async () => expect(await bridge.receipt(root.message_id)).toMatchObject({ status: "executing" }));
    return root;
  }
  return { bridge, host, state, call, start, metas, sessions,
    event(root: any, kind: EngineEventPayload["kind"], seq = 1, value: unknown = {}) { receive([{ runId: root.runId, engine: root.target.engine, sessionId: root.target.nativeSessionId, kind, seq, data: value }]); },
    idle(participant: typeof a) { sessions.set(participant.sessionId, { ...targetOf(participant), status: "idle" }); state.bySession[sessionKey(participant.engine, participant.sessionId, participant.workspacePath)].streaming = false; subscribers.forEach(cb => cb()); } };
}

it("uses the public request ID for update/read/impact acknowledgement and retains an exact sender-scoped receipt", async () => {
  const f = fixture(), root = await f.start();
  const update = await f.call(a, "send_message", { request_id: "fix-path", session_id: b.sessionId, message: "路径应为 X 👩🏽‍💻", update_of: "original", message_kind: "correction" });
  expect(update.mailbox).toMatchObject({ relation: "update", kind: "correction", parentRequestId: "original" });
  const read = await f.call(b, "read_messages", { request_id: "read-path" }, root.runId);
  expect(read.messages).toMatchObject([{ message_id: update.message_id, request_id: "fix-path", message_kind: "correction", message: expect.stringContaining("路径应为 X 👩🏽‍💻") }]);
  await expect(f.call(b, "acknowledge_message", { message_id: update.message_id, read_request_id: "read-path", outcome: "handled" }, root.runId)).rejects.toThrow("impact_review");
  await f.call(b, "acknowledge_message", { message_id: update.message_id, read_request_id: "read-path", outcome: "handled", impact_review: "暂停旧路径后续操作；核对已写文件和在途工具结果，保留他人改动。", response: "已核对并纳入后续工作" }, root.runId);
  expect(await f.call(a, "get_message_status", { request_id: "fix-path" })).toMatchObject({ receipt: { requestId: "fix-path", status: "completed", mailbox: { phase: "handled" } } });
  expect(useCrossSessionActivityStore.getState().records.find(record => record.requestId === "fix-path")?.mailbox?.impactReview).toContain("在途工具");
  expect(f.host.send).toHaveBeenCalledTimes(1);
});

it("preserves original receipt IDs across sender workspace aliases, including simultaneous retries", async () => {
  const f = fixture(), alias = { ...a, workspacePath: "g:\\source\\" };
  const args = { request_id: "same-request", session_id: b.sessionId, message: "same payload", wait_seconds: 0 };
  const [first, retry] = await Promise.all([f.call(a, "send_message", args), f.call(alias, "send_message", args, "run-later")]);
  expect(retry.message_id).toBe(first.message_id);
  expect(await f.call(alias, "get_message_status", { request_id: "same-request", wait_seconds: 0 }, "run-later")).toMatchObject({ receipt: { message_id: first.message_id } });
  expect(useCrossSessionActivityStore.getState().records).toHaveLength(1);
  expect(f.host.send).toHaveBeenCalledTimes(1);
});

it("interrupts a status wait with an own-inbox notice so a related reply can be read within the same turn", async () => {
  const f = fixture(), root = await f.start();
  const subscription = vi.spyOn(f.bridge, "onEvent");
  const waiting = f.call(a, "get_message_status", { request_id: "original", wait_seconds: 20 });
  await vi.waitFor(() => expect(subscription).toHaveBeenCalled());
  const reply = await f.call(b, "send_message", { request_id: "answer", session_id: a.sessionId, message: "这是所需的依赖信息", reply_to: "original" }, root.runId);
  const result = await waiting;
  expect(result.receipt.status).toBe("executing"); expect(result.inbox.pending).toBe(1);
  expect(result.inbox).not.toHaveProperty("messages");
  const read = await f.call(a, "read_messages", { request_id: "read-answer" });
  expect(read.messages).toMatchObject([{ message_id: reply.message_id, relation: { type: "reply", request_id: "original" } }]);
  await f.call(a, "acknowledge_message", { message_id: reply.message_id, read_request_id: "read-answer", outcome: "handled", response: "已收到关联答复" });
  expect(await f.call(b, "get_message_status", { request_id: "answer" }, root.runId)).toMatchObject({ receipt: { status: "completed" } });
  expect(f.host.send).toHaveBeenCalledTimes(1);
});

it("never attaches the destination inbox to the sender's status response", async () => {
  const f = fixture(), root = await f.start();
  const update = await f.call(a, "send_message", { request_id: "more", session_id: b.sessionId, message: "recipient-only payload", update_of: "original" });
  const status = await f.call(a, "get_message_status", { request_id: "original", wait_seconds: 0 });
  expect(status).not.toHaveProperty("inbox"); expect(JSON.stringify(status)).not.toContain("recipient-only payload");
  expect(await f.call(b, "get_inbox_status", {}, root.runId)).toMatchObject({ pending: 1 });
  await expect(f.call(a, "read_messages", { request_id: "wrong-target", message_ids: [update.message_id] })).rejects.toThrow("caller");
});

it("rejects identity overrides, conflicting relations and sender-scoped association forgery", async () => {
  const f = fixture(), root = await f.start();
  await expect(f.call(b, "read_messages", { request_id: "fake", session_id: a.sessionId }, root.runId)).rejects.toThrow("Invalid inbox");
  await expect(f.call(b, "get_inbox_status", { runId: "fake" }, root.runId)).rejects.toThrow("overrides");
  await expect(f.call(a, "send_message", { request_id: "conflict", session_id: b.sessionId, message: "x", update_of: "original", reply_to: "original" })).rejects.toThrow("mutually exclusive");
  await expect(f.call(b, "send_message", { request_id: "forged", session_id: a.sessionId, message: "x", update_of: "original" }, root.runId)).rejects.toThrow("different participants");
});

it("retains ordinary FIFO for independent questions while explaining an active mutual dependency", async () => {
  const f = fixture(), root = await f.start();
  await f.call(b, "send_message", { request_id: "independent-question", session_id: a.sessionId, message: "另一个独立问题" }, root.runId);
  const status = await f.call(a, "get_message_status", { request_id: "original", wait_seconds: 20 });
  expect(status.inbox).toMatchObject({ pending: 0, waitingOnCaller: [{ sender: b, requestId: "independent-question" }] });
  expect(status.inbox.nextAction).toContain("Do not spin indefinitely");
  expect((await f.call(a, "read_messages", { request_id: "independent-does-not-steer" })).messages).toEqual([]);
  expect(f.host.send).toHaveBeenCalledTimes(1);
});

it("keeps a late supplement linked after its root receipt is complete without replaying that root", async () => {
  const f = fixture(), root = await f.start(); f.event(root, "done"); f.idle(b);
  await vi.waitFor(async () => expect(await f.bridge.receipt(root.message_id)).toMatchObject({ status: "completed" }));
  const update = await f.call(a, "send_message", { request_id: "late", session_id: b.sessionId, message: "最终回复阶段之后到达的补充", update_of: "original" });
  await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.host.send).mock.calls[1][2]).toBe(update.runId);
  expect(vi.mocked(f.host.send).mock.calls[1][1]).not.toContain("请核对这个问题");
  expect(await f.call(a, "get_message_status", { request_id: "original" })).toMatchObject({ receipt: { status: "completed", runId: root.runId } });
});
