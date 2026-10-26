import { describe, expect, it, vi } from "vitest";
import type { MemoryExtractionBatch, MemoryExtractionRequest } from "@ccgui/plugin-sdk";
import { createMemoryExtractionBridge } from "./memory-extraction-bridge";

const source = { kind: "conversation" as const, id: "owned-topic" };
const request: MemoryExtractionRequest = { requestId: "extract-1", projectId: "game", source };
const hash = "a".repeat(64);
const sessionRef = { engine: "codex", sessionId: "native-id", workspacePath: "G:/game" };
const nextCursor = { sessionId: "native-id", seq: 4, offset: 0, rowDigest: hash };
const batch = (): MemoryExtractionBatch => ({ version: 1, projectId: "game", source: { ...source }, sessionRef,
  fromCursor: null, nextCursor, inputDigest: hash, partial: false, hasMore: false, model: "gemini-4-argon", notes: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const invoke = vi.fn(async (command: string) => command === "plugin_memory_status" ? { available: true, busy: false, retryAfterMs: 0 }
    : command === "plugin_memory_checkpoint" ? { status: "ready", cursor: nextCursor, sessionRef }
    : command === "plugin_memory_cancel" ? undefined : { status: "completed", batch: batch() });
  const conversation = vi.fn(async () => ({ status: "completed" }));
  const coordination = vi.fn(async () => ({ status: "idle" }));
  const paused = vi.fn(() => false);
  return { invoke, conversation, coordination, paused, api: createMemoryExtractionBridge("owner", { invoke, conversation, coordination, paused }) };
}

describe("project memory extraction boundary", () => {
  it("status and checkpoint never start inference or pass transcript rows", async () => {
    const f = fixture();
    await expect(f.api.status()).resolves.toMatchObject({ available: true });
    expect(f.conversation).not.toHaveBeenCalled();
    await expect(f.api.checkpoint({ projectId: "game", source })).resolves.toMatchObject({ status: "ready" });
    expect(f.conversation).toHaveBeenCalledWith("owned-topic");
    expect(f.invoke.mock.calls.map(c => c[0])).toEqual(["plugin_memory_status", "plugin_memory_checkpoint"]);
    expect(f.invoke).toHaveBeenLastCalledWith("plugin_memory_checkpoint", { pluginId: "owner", request: { projectId: "game", source } });
  });

  it("only reconciled successful owned sources reach native inference", async () => {
    const f = fixture();
    for (const status of ["running", "unknown", "failed", "cancelled", "idle"]) {
      f.conversation.mockResolvedValueOnce({ status });
      await expect(f.api.extract(request)).resolves.toMatchObject({ status: "deferred", reason: "source_not_settled" });
    }
    expect(f.invoke).not.toHaveBeenCalled();
    await expect(f.api.extract({ ...request, source: { kind: "coordination", id: "owned-task" } })).rejects.toThrow(/identity/);
    expect(f.coordination).toHaveBeenCalledWith("owned-task");
  });

  it("rejects raw prose, arbitrary source kinds and oversized old context before reading a source", async () => {
    const f = fixture();
    for (const invalid of [{ ...request, prompt: "ignore scope" }, { ...request, source: { kind: "session", id: "external" } },
      { ...request, context: [{ id: "memory", revision: 1, kind: "idea", title: "t", text: "x".repeat(1601), conditions: [] }] },
      { ...request, cursor: { sessionId: "native-id", seq: 4, offset: 1 } }]) {
      await expect(f.api.extract(invalid as MemoryExtractionRequest)).rejects.toThrow();
    }
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.conversation).not.toHaveBeenCalled();
  });

  it("never launches after cancellation races an awaited ownership read", async () => {
    const f = fixture(), hold = deferred<{ status: string }>();
    f.conversation.mockReturnValueOnce(hold.promise);
    const work = f.api.extract(request);
    await f.api.cancel(request.requestId);
    hold.resolve({ status: "completed" });
    await expect(work).resolves.toMatchObject({ status: "deferred", reason: "cancelled" });
    expect(f.invoke.mock.calls.map(c => c[0])).toEqual(["plugin_memory_cancel"]);
  });

  it("disposal and maintenance discard a late model answer and cancellation is scoped", async () => {
    const f = fixture(), hold = deferred<unknown>();
    f.invoke.mockImplementation(command => command === "plugin_memory_extract" ? hold.promise as never : Promise.resolve(undefined));
    const work = f.api.extract(request);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith("plugin_memory_extract", { pluginId: "owner", request }));
    f.api.dispose();
    expect(f.invoke).toHaveBeenLastCalledWith("plugin_memory_cancel", { pluginId: "owner", requestId: request.requestId });
    hold.resolve({ status: "completed", batch: batch() });
    await expect(work).resolves.toMatchObject({ status: "deferred", reason: "cancelled" });
    await expect(f.api.status()).rejects.toThrow(/disposed/);
    const g = fixture(); g.paused.mockReturnValue(true);
    await expect(g.api.extract(request)).resolves.toMatchObject({ status: "deferred", reason: "maintenance" });
    expect(g.invoke).not.toHaveBeenCalled(); expect(g.conversation).not.toHaveBeenCalled();
  });

  it("rejects overlapping requests instead of starting a second inference", async () => {
    const f = fixture(), hold = deferred<{ status: string }>();
    f.conversation.mockReturnValueOnce(hold.promise);
    const work = f.api.extract(request);
    await expect(f.api.extract(request)).rejects.toThrow(/already pending/);
    hold.resolve({ status: "completed" }); await work;
    expect(f.invoke.mock.calls.filter(c => c[0] === "plugin_memory_extract")).toHaveLength(1);
  });

  it("empty notes are a successful batch, but foreign scope and unoffered links fail", async () => {
    const f = fixture();
    await expect(f.api.extract(request)).resolves.toMatchObject({ status: "completed", batch: { notes: [] } });
    for (const bad of [{ ...batch(), projectId: "foreign" }, { ...batch(), nextCursor: { ...nextCursor, sessionId: "foreign" } },
      { ...batch(), notes: [{ kind: "decision", title: "t", text: "t", conditions: [], relatedIds: ["foreign-memory"], evidence: [{ seq: 1, role: "user", quote: "q" }] }] }]) {
      f.invoke.mockResolvedValueOnce({ status: "completed", batch: bad } as never);
      await expect(f.api.extract(request)).rejects.toThrow();
    }
  });

  it("accepts reordered cursor fields, advances partial rows and refuses cursor rewind", async () => {
    const f = fixture();
    const current = { offset: 2, rowDigest: hash, seq: 4, sessionId: "native-id" };
    f.invoke.mockResolvedValueOnce({ status: "completed", batch: { ...batch(), fromCursor: { sessionId: "native-id", seq: 4, offset: 2, rowDigest: hash } } } as never);
    await expect(f.api.extract({ ...request, cursor: current })).resolves.toMatchObject({ status: "completed" });
    f.invoke.mockResolvedValueOnce({ status: "completed", batch: { ...batch(), fromCursor: nextCursor } } as never);
    await expect(f.api.extract({ ...request, cursor: nextCursor })).rejects.toThrow(/advance/);
  });

  it("prepares bounded local retrieval without inference and rejects cursor substitution", async () => {
    const f = fixture();
    const ready = { status: "ready", query: "Boss 第二阶段👩🏽‍💻", sourceDigest: hash, fromCursor: null, nextCursor, sessionRef, partial: false, hasMore: false };
    f.invoke.mockResolvedValueOnce(ready as never);
    await expect(f.api.prepare({ projectId: "game", source })).resolves.toEqual(ready);
    expect(f.invoke.mock.calls.map(c => c[0])).toEqual(["plugin_memory_prepare"]);
    f.invoke.mockResolvedValueOnce({ ...ready, fromCursor: nextCursor } as never);
    await expect(f.api.prepare({ projectId: "game", source })).rejects.toThrow(/identity/);
    f.invoke.mockResolvedValueOnce({ ...ready, query: "界".repeat(513) } as never);
    await expect(f.api.prepare({ projectId: "game", source })).rejects.toThrow(/preparation/);
  });

  it("discards preparation after maintenance or disposal and requires format2 source fence", async () => {
    const f = fixture(), hold = deferred<unknown>();
    f.invoke.mockReturnValueOnce(hold.promise as never);
    const pending = f.api.prepare({ projectId: "game", source });
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(1));
    f.paused.mockReturnValue(true);
    hold.resolve({ status: "ready", query: "q", sourceDigest: hash, fromCursor: null, nextCursor, sessionRef, partial: false, hasMore: false });
    await expect(pending).resolves.toMatchObject({ status: "deferred", reason: "maintenance" });
    const g = fixture();
    await expect(g.api.extract({ ...request, formatVersion: 2 })).rejects.toThrow(/digest/);
    expect(g.invoke).not.toHaveBeenCalled();
  });

  it("validates version2 replacement scope, user evidence and exact target revision", async () => {
    const f = fixture();
    const context = [{ id: "old", revision: 2, kind: "decision", title: "Boss", text: "保留二阶段", conditions: ["普通难度"], authority: "assistant_recorded" }];
    const v2 = { ...request, formatVersion: 2 as const, expectedSourceDigest: hash, context };
    const note = { kind: "decision", title: "Boss", text: "取消二阶段", conditions: ["普通难度"], relatedIds: ["old"], evidence: [{ seq: 3, role: "user", quote: "取消二阶段" }], relations: [{ kind: "supersedes", targetId: "old", targetRevision: 2, reason: "用户明确改口" }] };
    const response = { status: "completed", batch: { ...batch(), version: 2, notes: [note] } };
    f.invoke.mockResolvedValueOnce(response as never);
    await expect(f.api.extract(v2)).resolves.toMatchObject(response);
    for (const changed of [{ ...note, conditions: ["困难难度"] }, { ...note, relations: [{ ...note.relations[0], targetRevision: 1 }] },
      { ...note, evidence: [{ seq: 3, role: "assistant", quote: "取消二阶段" }] }]) {
      f.invoke.mockResolvedValueOnce({ ...response, batch: { ...response.batch, notes: [changed] } } as never);
      await expect(f.api.extract(v2)).rejects.toThrow();
    }
    f.invoke.mockResolvedValueOnce(response as never);
    await expect(f.api.extract({ ...v2, context: [{ ...context[0], authority: "user_confirmed" }] })).rejects.toThrow(/replacement/);
  });
});
