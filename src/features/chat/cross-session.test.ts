import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostChatReceipt, HostChatTarget } from "@ccgui/plugin-sdk";
import { cancelCrossSessionMessage, createCrossSessionHandler, crossSessionParticipantKey, sendCrossSessionMessageNow, crossSessionRecordMatchesParticipant, guardClaudeProcess, isCrossSessionRecordUnread, startCrossSessionRuntime, useCrossSessionActivityStore, type CrossSessionCommunicationRecord, type CrossSessionRequest } from "./cross-session";
import { createHostChatBridge, type HostChatFacade } from "@/features/plugins/runtime/chat-bridge";
import { EMPTY_SESSION } from "./store/stream";
import { sessionKey } from "./store/persistence";
import type { ChatStore } from "./store/types";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import { createRuntimeCheckpointCoordinator } from "@/lib/runtime-checkpoint";

const transport = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => null),
  listen: vi.fn(async (_event: string, _callback?: unknown) => () => {}), isWeb: false }));
vi.mock("@/lib/transport", () => transport);
vi.mock("./store", () => ({ useChatStore: { getState: vi.fn(), subscribe: vi.fn(() => () => {}) }, sessionKey: (engine: string, id: string) => `${engine}/${id}` }));
const sender = { runId: "run-sender", engine: "claude", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", workspacePath: "G:/sender" };
const target = { engine: "claude", sessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/target" };
const target2 = { ...target, sessionId: "11111111-2222-2222-2222-222222222222" };
const bridges: Array<ReturnType<typeof createHostChatBridge>> = [];
function checkpoint() {
  const checkpoint = createRuntimeCheckpointCoordinator();
  checkpoint.initialize(undefined, { requiredParticipants: [] });
  return checkpoint;
}
function request(method = "send_message", args: Record<string, unknown> = {}, from = sender): CrossSessionRequest {
  return { requestId: "transport-request", sender: from, method, arguments: { request_id: "retry-1", session_id: target.sessionId, message: "Please inspect this", ...args } };
}
function fixture(status: "idle" | "busy" | "awaiting_permission" = "idle") {
  const data = new Map<string, unknown>(); const observers = new Set<() => void>();
  let onEngineEvents: ((events: Array<{ runId: string; engine: string; sessionId: string; seq: number; kind: string; data?: unknown }>) => void) | undefined;
  const meta = { ...target, title: "Target", preview: "private preview", model: "saved-model", effort: "high", provider: "saved-provider" } as SessionMeta;
  const rows = { sessions: [meta], archived: [] as SessionMeta[], workspaces: [{ path: target.workspacePath }] as Workspace[] };
  const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
  const state = { initialized: true, bySession: {}, archivedSessionKeys: {}, openTabs: [], active: sender, drafts: { draft: "do not alter" }, activeEngine: "codex", permission: "manual" } as unknown as ChatStore;
  state.selectSession = vi.fn(async (engine, sessionId, workspacePath) => {
    state.openTabs.push({ engine, sessionId, workspacePath });
    state.bySession[key] = { ...EMPTY_SESSION, messages: [], activeModel: meta.model, activeEffort: meta.effort, activeProvider: meta.provider };
  });
  const host: HostChatFacade = { identity: { clientInstanceId: "desktop", windowId: "window" }, current: () => null,
    inspect: (t) => state.bySession[key] && state.openTabs.some((tab) => tab.sessionId === t.nativeSessionId && tab.engine === t.engine && tab.workspacePath === t.workspacePath) ? { ...t, status } : null,
    send: vi.fn(async (t, _prompt, runId) => { status = "busy"; return { runId, sessionId: t.nativeSessionId }; }),
    subscribe: (cb) => { observers.add(cb); return () => { observers.delete(cb); }; }, wasInterrupted: () => false };
  const bridge = createHostChatBridge("cross-tests", { get: async (_id, k) => data.get(k) ?? null, set: async (_id, k, v) => { data.set(k, structuredClone(v)); }, delete: async (_id, k) => { data.delete(k); } }, { host: async () => host, listen: async (cb) => { onEngineEvents = cb as typeof onEngineEvents; return () => {}; }, checkpoint: checkpoint() });
  bridges.push(bridge);
  const handler = createCrossSessionHandler({ store: { getState: () => state }, bridge, catalog: async () => rows });
  return { handler, state, rows, host, bridge, idle: () => { status = "idle"; observers.forEach((cb) => cb()); }, emitEvents: (events: Parameters<NonNullable<typeof onEngineEvents>>[0]) => onEngineEvents?.(events) };
}
beforeEach(() => {
  vi.clearAllMocks(); transport.invoke.mockReset().mockResolvedValue(null); transport.listen.mockReset().mockResolvedValue(() => {});
  vi.stubGlobal("crypto", webcrypto); transport.isWeb = false;
});
afterEach(() => { bridges.splice(0).forEach((bridge) => bridge.dispose()); vi.unstubAllGlobals(); });
describe("host cross-session messaging", () => {
  it("loads an unopened idle exact target before sending an attributed prompt and preserves active/draft state", async () => {
    const f = fixture(); const active = f.state.active; const drafts = f.state.drafts;
    const receipt = await f.handler(request()) as { requestId: string; target: HostChatTarget };
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(1));
    expect(f.state.selectSession).toHaveBeenCalledWith(target.engine, target.sessionId, target.workspacePath, { background: true, meta: f.rows.sessions[0] });
    expect(receipt.requestId).toBe("retry-1"); expect(receipt.target.nativeSessionId).toBe(target.sessionId);
    expect(vi.mocked(f.host.send).mock.calls[0][1]).toContain(sender.sessionId);
    expect(vi.mocked(f.host.send).mock.calls[0][1]).toContain("Please inspect this");
    expect(f.state.active).toBe(active); expect(f.state.drafts).toBe(drafts); expect(f.state.permission).toBe("manual");
  });
  it.each(["busy", "awaiting_permission"] as const)("queues a %s target and sends only after it becomes idle", async (status) => {
    const f = fixture(status); const receipt = await f.handler(request()) as { status: string };
    expect(receipt.status).toBe("queued"); expect(f.host.send).not.toHaveBeenCalled();
    f.idle(); await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(1));
  });
  it("lists unopened saved local chats without exposing previews or messages", async () => {
    const f = fixture(); f.rows.sessions.push({ ...target2, title: "Other", remote: true } as SessionMeta);
    const result = await f.handler(request("list_chats", { query: "Target", limit: 1 }));
    expect(result).toEqual({ chats: [{ engine: target.engine, session_id: target.sessionId, workspace_path: target.workspacePath, title: "Target", status: "idle", cache_warmth: "unknown" }] });
    expect(JSON.stringify(result)).not.toContain("private preview"); expect(f.state.selectSession).not.toHaveBeenCalled();
  });
  it("keeps idle_seconds separate from cache retention evidence", async () => {
    const f = fixture();
    f.rows.sessions[0].updatedAt = Date.now() - 45_000;
    const result = await f.handler(request("list_chats", { query: "Target", limit: 1 })) as { chats: Array<Record<string, unknown>> };
    expect(result.chats[0]).toMatchObject({
      engine: target.engine,
      session_id: target.sessionId,
      status: "idle",
      cache_warmth: "unknown",
    });
    expect(typeof result.chats[0].idle_seconds).toBe("number");
    expect(result.chats[0].idle_seconds as number).toBeGreaterThanOrEqual(44);
    f.rows.sessions[0].promptCache = { startedAt: Date.now() - 20 * 60_000, observedAt: Date.now() - 19 * 60_000, ttlSeconds: 1800, source: "openai-policy" };
    const withCache = await f.handler(request("list_chats", { query: "Target", limit: 1 })) as { chats: Array<Record<string, unknown>> };
    expect(withCache.chats[0]).toMatchObject({ cache_warmth: "hot", cache_retention_seconds: 1800, cache_evidence: "openai-policy" });
    f.rows.sessions[0].engine = "agy";
    f.rows.sessions[0].promptCache = { startedAt: Date.now() - 60_000, observedAt: Date.now() - 30_000, ttlSeconds: 900, source: "agy-vertex-reference", reference: { maxTtlSeconds: 1200, cacheReadTokens: 900, promptTokens: 1000 } };
    const reference = await f.handler(request("list_chats", { query: "Target", limit: 1 })) as { chats: Array<Record<string, unknown>> };
    expect(reference.chats[0]).toMatchObject({ cache_warmth: "hot", cache_reference: true, cache_retention_max_seconds: 1200, last_cache_read_tokens: 900 });
    f.rows.sessions[0].engine = "cursor";
    const disabled = await f.handler(request("list_chats", { query: "Target", limit: 1 })) as { chats: Array<Record<string, unknown>> };
    expect(disabled.chats[0].cache_warmth).toBe("unknown");
    expect(disabled.chats[0]).not.toHaveProperty("cache_retention_seconds");
  });
  it.each(["unknown", "short", "ambiguous", "archived", "remote", "remote-workspace", "unregistered", "self", "self-path-variant", "no-sender"])("rejects %s without preparing or sending", async (kind) => {
    const f = fixture(); let args: Record<string, unknown> = {}; let from = sender;
    if (kind === "unknown") args = { session_id: "unknown-session" };
    if (kind === "short") args = { session_id: "1111" };
    if (kind === "ambiguous") { f.rows.sessions.push({ ...target2 } as SessionMeta); args = { session_id: "11111111" }; }
    if (kind === "archived") f.rows.archived.push(f.rows.sessions[0]);
    if (kind === "remote") f.rows.sessions[0].remote = true;
    if (kind === "remote-workspace") f.rows.workspaces[0].meta = { wsl: { hostId: "host" } };
    if (kind === "unregistered") f.rows.workspaces = [];
    if (kind === "self") from = { ...sender, ...target };
    if (kind === "self-path-variant") from = { ...sender, ...target, workspacePath: "g:\\target\\" };
    if (kind === "no-sender") from = { ...sender, sessionId: null } as unknown as typeof sender;
    await expect(f.handler(request("send_message", args, from))).rejects.toThrow();
    expect(f.state.selectSession).not.toHaveBeenCalled(); expect(f.host.send).not.toHaveBeenCalled();
  });
  it("resolves an unambiguous prefix and rejects conflicting native identities even with exact workspace", async () => {
    const f = fixture(); await f.handler(request("send_message", { session_id: "11111111" }));
    expect(f.state.selectSession).toHaveBeenCalledWith(target.engine, target.sessionId, target.workspacePath, expect.anything());
    const conflict = fixture(); conflict.rows.sessions.push({ ...target, workspacePath: "G:/conflict" } as SessionMeta); conflict.rows.workspaces.push({ path: "G:/conflict" } as Workspace);
    await expect(conflict.handler(request("send_message", { workspace_path: target.workspacePath }))).rejects.toThrow(/Conflicting/);
  });
  it("returns one receipt across concurrent retries and later sender turns, rejects changed payload and isolates source chats", async () => {
    const f = fixture("busy");
    const [first, second] = await Promise.all([f.handler(request()), f.handler(request())]) as Array<{ runId: string }>;
    expect(first.runId).toBe(second.runId);
    await expect(f.handler(request("send_message", { message: "changed" }))).rejects.toThrow(/different/);
    expect(await f.handler(request("get_message_status"))).toMatchObject({ receipt: { runId: first.runId, requestId: "retry-1" } });
    const laterSender = { ...sender, runId: "run-later" };
    expect(await f.handler(request("get_message_status", {}, laterSender))).toMatchObject({ receipt: { runId: first.runId } });
    expect(await f.handler(request("send_message", {}, laterSender))).toMatchObject({ runId: first.runId });
    const otherSender = { ...sender, sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    expect(await f.handler(request("get_message_status", {}, otherSender))).toEqual({ receipt: null });
    const other = await f.handler(request("send_message", {}, otherSender)) as { runId: string };
    expect(other.runId).not.toBe(first.runId);
  });
  it("rejects changed targets on a retry and returns previous receipt after the tab closes without reloading", async () => {
    const f = fixture("busy"); await f.handler(request()); f.state.openTabs = []; delete f.state.bySession[sessionKey(target.engine, target.sessionId, target.workspacePath)];
    await expect(f.handler(request())).resolves.toMatchObject({ status: "queued" }); expect(f.state.selectSession).toHaveBeenCalledTimes(1);
    f.rows.sessions.push({ ...target2 } as SessionMeta);
    await expect(f.handler(request("send_message", { session_id: target2.sessionId }))).rejects.toThrow(/different/);
  });
  it("rejects history failures without falling back to active and accepts past engine errors", async () => {
    const f = fixture(); vi.mocked(f.state.selectSession).mockRejectedValueOnce(new Error("history read failed"));
    await expect(f.handler(request())).rejects.toThrow(/history read failed/); expect(f.host.send).not.toHaveBeenCalled();
    vi.mocked(f.state.selectSession).mockImplementationOnce(async () => { f.state.openTabs = [target]; f.state.bySession[sessionKey(target.engine, target.sessionId, target.workspacePath)] = { ...EMPTY_SESSION, error: "past engine error" }; });
    await expect(f.handler(request())).resolves.toBeTruthy();
  });
  it.each([{ message: " " }, { message: "x".repeat(130001) }, { request_id: "spaces invalid" }, { request_id: "x".repeat(65) }, { wait_seconds: -1 }, { wait_seconds: 21 }, { wait_seconds: 1.5 }, { wait_seconds: "10" }])("validates message, client id, and wait_seconds before preparation", async (args) => {
    const f = fixture(); await expect(f.handler(request("send_message", args))).rejects.toThrow(); expect(f.state.selectSession).not.toHaveBeenCalled();
  });
  it("waits up to wait_seconds and returns the target chat's assistant reply in send_message and get_message_status", async () => {
    const f = fixture();
    const pendingSend = f.handler(request("send_message", { request_id: "consult-1", wait_seconds: 5 }));
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(1));
    const runId = vi.mocked(f.host.send).mock.calls[0][2];
    f.emitEvents([
      { runId, engine: target.engine, sessionId: target.sessionId, seq: 1, kind: "delta", data: "Consultation reply: " },
      { runId, engine: target.engine, sessionId: target.sessionId, seq: 2, kind: "delta", data: "everything looks good." },
      { runId, engine: target.engine, sessionId: target.sessionId, seq: 3, kind: "done" },
    ]);
    await expect(pendingSend).resolves.toMatchObject({
      requestId: "consult-1",
      status: "completed",
      text: "Consultation reply: everything looks good.",
    });

    // Multi-turn follow-up where send_message returns before completion and get_message_status waits for the reply
    f.idle();
    const secondSend = await f.handler(request("send_message", { request_id: "consult-2", message: "Follow-up question", wait_seconds: 0 })) as { runId: string; status: string };
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(2));
    const pendingStatus = f.handler(request("get_message_status", { request_id: "consult-2", wait_seconds: 5 }));
    f.emitEvents([
      { runId: secondSend.runId, engine: target.engine, sessionId: target.sessionId, seq: 1, kind: "delta", data: "Second turn reply" },
      { runId: secondSend.runId, engine: target.engine, sessionId: target.sessionId, seq: 2, kind: "done" },
    ]);
    await expect(pendingStatus).resolves.toMatchObject({
      receipt: {
        requestId: "consult-2",
        status: "completed",
        text: "Second turn reply",
      },
    });
  });
  it("tracks real-time waiting, replying stream, and completion states in useCrossSessionActivityStore", async () => {
    useCrossSessionActivityStore.getState().reset();
    const f = fixture("busy");
    const receipt = await f.handler(request("send_message", {
      request_id: "live-ui-1",
      session_id: target.sessionId,
      message: "Check status panel",
    })) as { status: string };
    expect(receipt.status).toBe("queued");
    expect(useCrossSessionActivityStore.getState().records[0]).toMatchObject({
      requestId: "live-ui-1",
      status: "queued",
      message: "Check status panel",
    });

    f.idle();
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledTimes(1));
    const sentRunId = vi.mocked(f.host.send).mock.calls[0][2];
    await vi.waitFor(() => expect(useCrossSessionActivityStore.getState().records[0]?.status).toBe("executing"));

    f.emitEvents([
      { runId: sentRunId, engine: target.engine, sessionId: target.sessionId, seq: 1, kind: "delta", data: "Streaming chunk 1... " },
    ]);
    await vi.waitFor(() =>
      expect(useCrossSessionActivityStore.getState().records[0]).toMatchObject({
        status: "executing",
        replyText: "Streaming chunk 1... ",
      }),
    );

    f.emitEvents([
      { runId: sentRunId, engine: target.engine, sessionId: target.sessionId, seq: 2, kind: "delta", data: "Final answer." },
      { runId: sentRunId, engine: target.engine, sessionId: target.sessionId, seq: 3, kind: "done" },
    ]);
    await vi.waitFor(() =>
      expect(useCrossSessionActivityStore.getState().records[0]).toMatchObject({
        status: "completed",
        replyText: "Streaming chunk 1... Final answer.",
      }),
    );

    useCrossSessionActivityStore.getState().clearFinished();
    expect(useCrossSessionActivityStore.getState().records).toHaveLength(0);
  });
  it.each(["catalog", "history"])("does not submit after runtime disposal during %s preparation", async (phase) => {
    const f = fixture(); let active = true; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const catalog = vi.fn(async () => { if (phase === "catalog") await gate; return f.rows; });
    if (phase === "history") vi.mocked(f.state.selectSession).mockImplementationOnce(async () => { await gate; });
    const submit = vi.spyOn(f.bridge, "submit");
    const handler = createCrossSessionHandler({ store: { getState: () => f.state }, bridge: f.bridge, catalog, isActive: () => active });
    const pending = handler(request());
    if (phase === "history") await vi.waitFor(() => expect(f.state.selectSession).toHaveBeenCalledTimes(1));
    else await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
    active = false; release();
    await expect(pending).rejects.toThrow(/disposed/);
    expect(submit).not.toHaveBeenCalled(); expect(f.host.send).not.toHaveBeenCalled();
  });
});
describe("cross-session activity review", () => {
  const store = useCrossSessionActivityStore;
  const record = (overrides: Partial<CrossSessionCommunicationRecord> = {}): CrossSessionCommunicationRecord => ({
    scopedId: "activity-1", requestId: "request-1", sender, target, message: "Inspect this",
    status: "completed", replyText: "Done", acceptedAt: 1, updatedAt: 2, ...overrides,
  });
  const receipt = (overrides: Partial<HostChatReceipt> = {}): HostChatReceipt => ({
    requestId: "activity-1", target: { client: "ccgui", engine: target.engine, nativeSessionId: target.sessionId,
      guiSessionId: target.sessionId, workspacePath: target.workspacePath, clientInstanceId: "client", windowId: "window" },
    runId: "run-1", status: "completed", text: "Done", acceptedAt: 1, updatedAt: 3, ...overrides,
  });
  beforeEach(() => store.getState().reset());

  it("isolates participant identity by engine, session, and workspace, ignoring titles", () => {
    const current = record();
    expect(crossSessionParticipantKey(sender)).toBe(JSON.stringify([sender.engine, sender.sessionId, sender.workspacePath]));
    expect(crossSessionRecordMatchesParticipant(current, { ...target, title: "Renamed" })).toBe(true);
    for (const other of [{ ...target, workspacePath: "G:/other" }, { ...target, engine: "codex" }, target2]) {
      expect(crossSessionRecordMatchesParticipant(current, other)).toBe(false);
      expect(isCrossSessionRecordUnread(current, other)).toBe(false);
      store.getState().upsertRecord(current);
      const before = store.getState();
      store.getState().markReviewed([current], other);
      expect(store.getState()).toBe(before);
    }
  });

  it("reviews each side independently and makes repeated or unmatched reviews no-ops", () => {
    store.getState().upsertRecord(record());
    store.getState().upsertRecord(record({ scopedId: "activity-2" }));
    store.getState().markReviewed([store.getState().records[1]], sender);
    const current = store.getState().records.find((r) => r.scopedId === "activity-1")!;
    expect(isCrossSessionRecordUnread(current, sender)).toBe(false);
    expect(isCrossSessionRecordUnread(current, target)).toBe(true);
    expect(isCrossSessionRecordUnread(current)).toBe(true);
    const before = store.getState();
    store.getState().markReviewed([current], sender);
    store.getState().markReviewed([record({ scopedId: "missing" })]);
    expect(store.getState()).toBe(before);
    store.getState().markReviewed([current]);
    expect(isCrossSessionRecordUnread(store.getState().records.find((r) => r.scopedId === "activity-1")!)).toBe(false);
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(true);
  });

  it("preserves review across duplicate receipts and timestamp-only upserts", () => {
    store.getState().upsertRecord(record());
    store.getState().markReviewed(store.getState().records);
    const reviewedBy = store.getState().records[0].reviewedBy;
    store.getState().applyReceipt(receipt({ updatedAt: 100 }));
    store.getState().upsertRecord(record({ updatedAt: 200 }));
    expect(store.getState().records[0].reviewedBy).toBe(reviewedBy);
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(false);
  });

  it.each([
    { text: "Arrived after rendering" }, { status: "failed" as const }, { error: "New failure details" },
  ])("does not acknowledge a newer result using an older rendered snapshot: %j", (change) => {
    store.getState().upsertRecord(record());
    const observed = store.getState().records;
    store.getState().applyReceipt(receipt(change));
    const before = store.getState();
    store.getState().markReviewed(observed, sender);
    store.getState().markReviewed(observed);
    expect(store.getState()).toBe(before);
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(true);
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(true);
    store.getState().markReviewed(store.getState().records);
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(false);
  });

  it("accepts a rendered snapshot across timestamp-only updates but not changed participants", () => {
    store.getState().upsertRecord(record());
    const observed = store.getState().records;
    store.getState().applyReceipt(receipt({ updatedAt: 100 }));
    store.getState().markReviewed(observed, sender);
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(false);
    store.getState().upsertRecord(record({ target: { ...target, workspacePath: "G:/different" } }));
    const before = store.getState();
    store.getState().markReviewed(observed);
    expect(store.getState()).toBe(before);
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(true);
  });

  it.each([
    { text: "New reply" }, { status: "failed" as const }, { error: "New error" },
  ])("makes changed terminal receipt content unread again: %j", (change) => {
    store.getState().upsertRecord(record());
    store.getState().markReviewed(store.getState().records);
    store.getState().applyReceipt(receipt(change));
    expect(store.getState().records[0].reviewedBy).toBeUndefined();
    expect(isCrossSessionRecordUnread(store.getState().records[0], sender)).toBe(true);
    expect(isCrossSessionRecordUnread(store.getState().records[0], target)).toBe(true);
  });

  it("invalidates review for changed upserts and failures but keeps duplicate failures reviewed", () => {
    store.getState().upsertRecord(record());
    store.getState().markReviewed(store.getState().records);
    store.getState().upsertRecord(record({ replyText: "Updated" }));
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(true);
    store.getState().markReviewed(store.getState().records);
    store.getState().markFailed("activity-1", "Failed");
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(true);
    store.getState().markReviewed(store.getState().records);
    store.getState().markFailed("activity-1", "Failed");
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(false);
    store.getState().markFailed("activity-1", "Different failure");
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(true);
  });

  it("does not let viewing active work consume its eventual terminal notification", () => {
    store.getState().upsertRecord(record());
    store.getState().markReviewed(store.getState().records);
    store.getState().applyReceipt(receipt({ status: "executing" }));
    expect(store.getState().records[0].reviewedBy).toBeUndefined();
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(false);
    const before = store.getState();
    store.getState().markReviewed(store.getState().records);
    expect(store.getState()).toBe(before);
    const activeSnapshot = store.getState().records;
    store.getState().applyReceipt(receipt());
    store.getState().markReviewed(activeSnapshot);
    expect(isCrossSessionRecordUnread(store.getState().records[0])).toBe(true);
  });
});

describe("cross-session request subscription lifecycle", () => {
  it("announces readiness only after subscription and unregisters on cleanup", async () => {
    const off = vi.fn(); transport.listen.mockResolvedValueOnce(off);
    const dispose = startCrossSessionRuntime();
    expect(transport.invoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("host_chat_ready", { ready: true }));
    dispose(); await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("host_chat_ready", { ready: false })); expect(off).toHaveBeenCalledTimes(1);
  });
  it("cleans up a subscription resolving after disposal without announcing ready", async () => {
    let resolve!: (off: () => void) => void; transport.listen.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const dispose = startCrossSessionRuntime(); dispose(); const off = vi.fn(); resolve(off);
    await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(1));
    expect(transport.invoke).not.toHaveBeenCalledWith("host_chat_ready", { ready: true });
  });
  it("does nothing for web hosts", () => {
    transport.isWeb = true; startCrossSessionRuntime()(); expect(transport.listen).not.toHaveBeenCalled(); expect(transport.invoke).not.toHaveBeenCalled();
  });
  it("does not let an old readiness cleanup disable a remounted subscription", async () => {
    let acknowledge!: () => void; const gate = new Promise<null>((r) => { acknowledge = () => r(null); });
    let firstAck = true;
    transport.invoke.mockImplementation(async (command?: unknown, args?: unknown) => {
      if (command === "host_chat_ready" && (args as { ready?: boolean })?.ready && firstAck) { firstAck = false; return gate; }
      return null;
    });
    const off1 = vi.fn(); const off2 = vi.fn(); let subscriptions = 0;
    transport.listen.mockImplementation(async (event?: unknown) => event === "host-chat://request" ? (++subscriptions === 1 ? off1 : off2) : () => {});
    const readinessCalls = () => transport.invoke.mock.calls.filter(([command]) => command === "host_chat_ready");
    const first = startCrossSessionRuntime();
    await vi.waitFor(() => expect(readinessCalls()).toHaveLength(1));
    first(); const second = startCrossSessionRuntime(); acknowledge();
    await vi.waitFor(() => expect(readinessCalls()).toHaveLength(2));
    expect(readinessCalls()).toEqual([["host_chat_ready", { ready: true }], ["host_chat_ready", { ready: true }]]);
    second(); await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("host_chat_ready", { ready: false }));
    expect(off1).toHaveBeenCalledTimes(1); expect(off2).toHaveBeenCalledTimes(1);
  });
});

describe("Claude native process retirement guard", () => {
  function guardedFixture() {
    const exact: HostChatTarget = { client: "ccgui", engine: target.engine, nativeSessionId: target.sessionId, guiSessionId: target.sessionId,
      workspacePath: target.workspacePath, clientInstanceId: "desktop", windowId: "window" };
    const send = vi.fn(async (_target, _prompt, runId: string) => ({ runId, sessionId: target.sessionId }));
    const base: HostChatFacade = { identity: exact, inspect: (t) => ({ ...t, status: "idle" }), current: () => ({ ...exact, status: "idle" }),
      send, subscribe: () => () => {}, wasInterrupted: () => false };
    let ended!: (event: { runId: string }) => void;
    const off = vi.fn(); const running = vi.fn(async () => true);
    const guard = guardClaudeProcess(base, { running, ended: async (callback) => { ended = callback; return off; } });
    const data = new Map<string, unknown>();
    const bridge = createHostChatBridge("guard-tests", { get: async (_id, k) => data.get(k) ?? null, set: async (_id, k, v) => { data.set(k, structuredClone(v)); }, delete: async () => {} },
      { host: async () => guard, listen: async () => () => {}, checkpoint: checkpoint() });
    bridges.push(bridge);
    return { bridge, guard, send, running, off, exact, ended: (runId = sender.runId) => ended({ runId }) };
  }
  it("waits for a lingering native child without sending and wakes only on retirement invalidation", async () => {
    const f = guardedFixture(); await f.bridge.submit({ requestId: "lingering", target: f.exact, prompt: "later" });
    await vi.waitFor(async () => expect(await f.bridge.receipt("lingering")).toMatchObject({ status: "queued" }));
    expect(f.send).not.toHaveBeenCalled(); expect(f.running).toHaveBeenCalledTimes(1); expect(f.guard.inspect(f.exact)?.status).toBe("busy");
    f.running.mockResolvedValue(false); f.ended();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1)); expect(f.running).toHaveBeenCalledTimes(2);
    f.bridge.dispose(); await vi.waitFor(() => expect(f.off).toHaveBeenCalledTimes(1));
  });
  it("re-probes a stale true result when retirement arrives during the native await", async () => {
    const f = guardedFixture(); let resolve!: (running: boolean) => void;
    f.running.mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockResolvedValue(false);
    await f.bridge.submit({ requestId: "race", target: f.exact, prompt: "later" });
    await vi.waitFor(() => expect(f.running).toHaveBeenCalledTimes(1));
    f.ended(); resolve(true);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1)); expect(f.running).toHaveBeenCalledTimes(2);
    expect(f.guard.inspect(f.exact)?.status).toBe("idle");
  });
  it("treats retirement as invalidation and checks again before sending when another process remains", async () => {
    const f = guardedFixture(); await f.bridge.submit({ requestId: "remaining", target: f.exact, prompt: "later" });
    await vi.waitFor(async () => expect(await f.bridge.receipt("remaining")).toMatchObject({ status: "queued" }));
    f.ended(); await vi.waitFor(() => expect(f.running).toHaveBeenCalledTimes(2));
    expect(f.send).not.toHaveBeenCalled(); expect(f.guard.inspect(f.exact)?.status).toBe("busy");
  });
  it("wakes a target after an unregistered plugin or mission process retires", async () => {
    const f = guardedFixture(); await f.bridge.submit({ requestId: "plugin-busy", target: f.exact, prompt: "later" });
    await vi.waitFor(async () => expect(await f.bridge.receipt("plugin-busy")).toMatchObject({ status: "queued" }));
    f.running.mockResolvedValue(false); f.ended("unregistered-plugin-run");
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(f.running).toHaveBeenCalledTimes(2);
  });
});

describe("sending a waiting cross-session message ahead", () => {
  const receipt = (status: HostChatReceipt["status"]): HostChatReceipt => ({
    requestId: "cross:waiting", target: { client: "ccgui", engine: target.engine, nativeSessionId: target.sessionId,
      guiSessionId: target.sessionId, workspacePath: target.workspacePath, clientInstanceId: "client", windowId: "window" },
    runId: "run-waiting", status, acceptedAt: 1, updatedAt: 2,
  });
  function store(streaming: boolean) {
    const interrupt = vi.fn(async () => {});
    const state = { bySession: { [`${target.engine}/${target.sessionId}`]: { ...EMPTY_SESSION, streaming } }, interrupt } as unknown as ChatStore;
    return { interrupt, store: { getState: () => state } };
  }
  beforeEach(() => useCrossSessionActivityStore.getState().reset());

  it("prioritizes first, then stops only the target's running turn", async () => {
    const order: string[] = [];
    const controls = { prioritize: vi.fn(async () => { order.push("prioritize"); return receipt("queued"); }), cancel: vi.fn() };
    const running = store(true);
    running.interrupt.mockImplementation(async () => { order.push("interrupt"); });
    await sendCrossSessionMessageNow("cross:waiting", controls, running.store);
    expect(order).toEqual(["prioritize", "interrupt"]);
    expect(running.interrupt).toHaveBeenCalledWith(target);

    const idle = store(false);
    await sendCrossSessionMessageNow("cross:waiting", controls, idle.store);
    expect(idle.interrupt).not.toHaveBeenCalled();
  });

  it("never stops the target for a message that already left the queue or is unknown", async () => {
    for (const result of [receipt("executing"), receipt("completed"), null]) {
      const running = store(true);
      await sendCrossSessionMessageNow("cross:waiting", { prioritize: vi.fn(async () => result), cancel: vi.fn() }, running.store);
      expect(running.interrupt).not.toHaveBeenCalled();
    }
  });

  it("reports an unavailable runtime and records a withdrawal", async () => {
    await expect(sendCrossSessionMessageNow("cross:waiting", undefined)).rejects.toThrow("Host chat runtime is unavailable");
    useCrossSessionActivityStore.getState().upsertRecord({ scopedId: "cross:waiting", requestId: "waiting", sender, target,
      message: "m", status: "queued", acceptedAt: 1, updatedAt: 1 });
    const failed = { ...receipt("failed"), error: "Cancelled by the user before delivery" };
    await cancelCrossSessionMessage("cross:waiting", { prioritize: vi.fn(), cancel: vi.fn(async () => failed) });
    expect(useCrossSessionActivityStore.getState().records[0]).toMatchObject({ status: "failed", error: "Cancelled by the user before delivery" });
  });
});
